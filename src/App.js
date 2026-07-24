import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceArea,
  ReferenceLine,
} from "recharts";

const TARGET_RANGE = { low: 3.9, high: 10.0 }; // ммоль/л, из отчета п.1.4

const API_BASE = process.env.REACT_APP_API_BASE_URL;

const RANGE_OPTIONS = [
  { key: "1h", label: "1ч", period: "1h", ms: 1 * 60 * 60 * 1000 },
  { key: "6h", label: "6ч", period: "6h", ms: 6 * 60 * 60 * 1000 },
  { key: "24h", label: "24ч", period: "24h", ms: 24 * 60 * 60 * 1000 },
  { key: "7d", label: "7д", period: "168h", ms: 7 * 24 * 60 * 60 * 1000 },
  { key: "all", label: "Всё время", period: "all", ms: Infinity },
];

const MODELS = {
  nn: { key: "nn", label: "Нейросеть", color: "#0F6E56", staticAccuracy: 92 },
  ode: { key: "ode", label: "ОДУ-модель", color: "#7A3FA0", staticAccuracy: 87 },
};

const LS_SESSION_KEY = "gd_session";

function loadJSON(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function saveJSON(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // localStorage недоступен (приватный режим и т.п.) — молча игнорируем.
  }
}
function loadSession() {
  return loadJSON(LS_SESSION_KEY, null);
}
function saveSession(session) {
  saveJSON(LS_SESSION_KEY, session);
}
function clearSession() {
  try {
    window.localStorage.removeItem(LS_SESSION_KEY);
  } catch {
    // ignore
  }
}

function genPatientId() {
  return 100000 + Math.floor(Math.random() * 900000); // 6 цифр
}

// Glucose/GlucosePredicted у бэкенда — строки (sqlc мапит NUMERIC/DECIMAL из
// Postgres в string), поэтому всегда парсим через parseFloat.
function toNum(v) {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
}

async function apiFetch(path, options) {
  const res = await fetch(`${API_BASE}${path}`, options);
  if (!res.ok) throw new Error(`network: ${res.status}`);
  return res.json();
}

// ---- Больницы ----
async function fetchAllHospitals() {
  return apiFetch("/hospitals");
}
async function createHospital(name) {
  return apiFetch("/hospitals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}
async function findOrCreateHospital(name) {
  const hospitals = await fetchAllHospitals();
  const existing = (hospitals || []).find(
    (h) => h.Name.trim().toLowerCase() === name.trim().toLowerCase()
  );
  if (existing) return existing;
  return createHospital(name.trim());
}

function toNullUUID(uuidStr) {
  return uuidStr || null;
}
function fromNullUUID(value) {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object" && "UUID" in value) return value.Valid ? value.UUID : null;
  return null;
}

// ---- Админы ----
async function createAdminUser(hospitalId) {
  return apiFetch("/admin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hospital_id: toNullUUID(hospitalId) }),
  });
}
async function fetchAdmin(adminId) {
  return apiFetch(`/admin/${adminId}`);
}
async function fetchPatientsForAdmin(adminId) {
  return apiFetch(`/admin/user/${adminId}`);
}

// ---- Пациенты ----
async function createPatientUser(id, name, hospitalId) {
  return apiFetch("/user", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ 
      id: parseInt(id, 10), // ✅ Исправлено: отправляем число, а не строку
      name, 
      hospital_id: toNullUUID(hospitalId) 
    }),
  });
}
async function fetchPatientUser(patientId) {
  return apiFetch(`/user/${patientId}`);
}

async function resolveHospitalName(hospitalIdRaw) {
  const hospitalId = fromNullUUID(hospitalIdRaw);
  if (!hospitalId) return null;
  const hospitals = await fetchAllHospitals();
  const found = (hospitals || []).find((h) => h.ID === hospitalId);
  return found ? found.Name : null;
}

async function fetchPatientSnapshot(patientId, period) {
  return apiFetch(`/glucose_levels/${patientId}?time_period=${encodeURIComponent(period)}`);
}

async function fetchRecommendations(patientId) {
  return apiFetch(`/recommendations/${patientId}`);
}

function buildHistory(readings) {
  return [...(readings || [])]
    .map((r) => ({
      t: new Date(r.TimeOfReading).getTime(),
      time: r.TimeOfReading,
      actual: toNum(r.Glucose),
    }))
    .sort((a, b) => a.t - b.t);
}

function buildFutureForecastRows(modelPredictions, oduPredictions) {
  const map = new Map();
  (modelPredictions || []).forEach((p) => {
    const t = new Date(p.TimePredicted).getTime();
    const entry = map.get(t) || { t };
    entry.forecastNN = toNum(p.GlucosePredicted);
    map.set(t, entry);
  });
  (oduPredictions || []).forEach((p) => {
    const t = new Date(p.TimePredicted).getTime();
    const entry = map.get(t) || { t };
    entry.forecastODE = toNum(p.GlucosePredicted);
    map.set(t, entry);
  });
  return Array.from(map.values()).sort((a, b) => a.t - b.t);
}

function latestReadingFrom(history) {
  if (history.length === 0) return null;
  const last = history[history.length - 1];
  if (last.actual == null) return null;
  return {
    value: last.actual,
    measuredAt: last.time,
    status: classify(last.actual),
  };
}

// ✅ ИСПРАВЛЕНО: Берём последнее предсказание и прибавляем к нему 30 минут
function latestForecastFrom(predictions) {
  if (!predictions || predictions.length === 0) return null;

  // Сортируем по убыванию (сначала самые поздние)
  const sorted = [...predictions].sort(
    (a, b) => new Date(b.TimePredicted) - new Date(a.TimePredicted)
  );

  // Берём последнее (самое позднее) предсказание
  const last = sorted[0];
  const value = toNum(last.GlucosePredicted);
  if (value == null) return null;

  // Прибавляем 30 минут к времени предсказания
  const forecastTime = new Date(last.TimePredicted);
  forecastTime.setMinutes(forecastTime.getMinutes() + 30);

  return { 
    value, 
    forecastFor: forecastTime.toISOString() 
  };
}

function computeStats(historyRows) {
  const values = historyRows.map((d) => d.actual).filter((v) => v != null);
  if (values.length === 0) return { average: 0, min: 0, max: 0, timeInRange: 0 };
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const inRange =
    values.filter((v) => v >= TARGET_RANGE.low && v <= TARGET_RANGE.high).length /
    values.length;
  return {
    average: Number(avg.toFixed(1)),
    min: Number(min.toFixed(1)),
    max: Number(max.toFixed(1)),
    timeInRange: Number((inRange * 100).toFixed(1)),
  };
}

// --- База продуктов (локально) ---
const FOOD_DATABASE = [
  { name: "Овсянка на воде", calories: 88, protein: 3, fat: 1.7, carbs: 15 },
  { name: "Гречка варёная", calories: 110, protein: 4, fat: 1.1, carbs: 21 },
  { name: "Рис белый варёный", calories: 116, protein: 2.2, fat: 0.5, carbs: 25 },
  { name: "Куриная грудка варёная", calories: 165, protein: 31, fat: 3.6, carbs: 0 },
  { name: "Лосось запечённый", calories: 208, protein: 20, fat: 13, carbs: 0 },
  { name: "Яйцо куриное", calories: 155, protein: 13, fat: 11, carbs: 1.1 },
  { name: "Творог 5%", calories: 121, protein: 17, fat: 5, carbs: 3 },
  { name: "Йогурт натуральный", calories: 66, protein: 3.5, fat: 3.2, carbs: 4.7 },
  { name: "Хлеб цельнозерновой", calories: 247, protein: 13, fat: 3.4, carbs: 41 },
  { name: "Банан", calories: 89, protein: 1.1, fat: 0.3, carbs: 23 },
  { name: "Яблоко", calories: 52, protein: 0.3, fat: 0.2, carbs: 14 },
  { name: "Миндаль", calories: 579, protein: 21, fat: 50, carbs: 22 },
  { name: "Картофель варёный", calories: 82, protein: 2, fat: 0.1, carbs: 17 },
  { name: "Макароны варёные", calories: 131, protein: 5, fat: 1.1, carbs: 25 },
  { name: "Молоко 2.5%", calories: 52, protein: 2.8, fat: 2.5, carbs: 4.7 },
  { name: "Сыр твёрдый", calories: 350, protein: 25, fat: 27, carbs: 0 },
  { name: "Салат овощной", calories: 25, protein: 1.2, fat: 0.2, carbs: 4.5 },
  { name: "Мёд", calories: 304, protein: 0.3, fat: 0, carbs: 82 },
  { name: "Гранола", calories: 471, protein: 10, fat: 20, carbs: 64 },
  { name: "Авокадо", calories: 160, protein: 2, fat: 14.7, carbs: 8.5 },
];

function findFoodMatches(query) {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  return FOOD_DATABASE.filter((f) => f.name.toLowerCase().includes(q)).slice(0, 6);
}

function computeMacros(food, grams) {
  const factor = grams / 100;
  return {
    calories: Math.round(food.calories * factor),
    protein: Number((food.protein * factor).toFixed(1)),
    fat: Number((food.fat * factor).toFixed(1)),
    carbs: Number((food.carbs * factor).toFixed(1)),
  };
}

async function fetchNutritionLog(patientId) {
  await delay(200);
  return [
    {
      id: "n1",
      time: "08:22",
      food: "Овсянка на воде",
      grams: 250,
      ...computeMacros(FOOD_DATABASE[0], 250),
    },
    {
      id: "n2",
      time: "13:10",
      food: "Гречка варёная",
      grams: 200,
      ...computeMacros(FOOD_DATABASE[1], 200),
    },
    {
      id: "n3",
      time: "19:45",
      food: "Лосось запечённый",
      grams: 150,
      ...computeMacros(FOOD_DATABASE[4], 150),
    },
  ];
}

async function fetchWhatIfForecast(patientId, params, baseHistory) {
  await delay(350);
  if (baseHistory.length === 0) return { points: [], netEffect: 0 };

  const rnd = seedRandom(
    Math.round(params.carbsG * 3 + params.proteinG * 5 + params.activityMin + 1)
  );
  const carbEffect = params.carbsG * 0.06;
  const proteinEffect = params.proteinG * 0.025;
  const activityEffect = -params.activityMin * 0.05;
  const netEffect = carbEffect + proteinEffect + activityEffect;

  const last = baseHistory[baseHistory.length - 1];
  const stepMs =
    baseHistory.length >= 2
      ? last.t - baseHistory[baseHistory.length - 2].t
      : 30 * 60000;

  const horizon = 8;
  const stepWeights = [0.4, 0.7, 0.85, 0.93, 0.97, 0.99, 1, 1];
  const points = [{ t: last.t, whatIf: last.actual }];
  for (let i = 0; i < horizon; i++) {
    const value = Math.max(
      3,
      last.actual + netEffect * stepWeights[i] + (rnd() - 0.5) * 0.2
    );
    points.push({ t: last.t + (i + 1) * stepMs, whatIf: Number(value.toFixed(2)) });
  }
  return { points, netEffect: Number(netEffect.toFixed(2)) };
}

function seedRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function classify(value) {
  if (value < TARGET_RANGE.low) return "hypo";
  if (value > TARGET_RANGE.high) return "hyper";
  return "normal";
}

function getGlucoseTips(value, status) {
  if (status === "hypo") {
    if (value < 3.0) {
      return {
        severity: "critical",
        title: "Очень низкий уровень глюкозы",
        text:
          "Съешьте 15–20 г быстрых углеводов (сок, глюкозные таблетки, мёд). Проверьте уровень через 15 минут. Если улучшения нет — обратитесь за помощью.",
      };
    }
    return {
      severity: "warning",
      title: "Низкий уровень глюкозы",
      text:
        "Рассмотрите приём быстрых углеводов: сок, мёд, сладкий напиток (~15 г). Перепроверьте показатель через 15 минут («правило 15/15»).",
    };
  }
  if (status === "hyper") {
    if (value > 13.9) {
      return {
        severity: "critical",
        title: "Очень высокий уровень глюкозы",
        text:
          "Пейте воду небольшими порциями, избегайте дополнительных быстрых углеводов. При плохом самочувствии или наличии кетонов — свяжитесь с врачом.",
      };
    }
    return {
      severity: "warning",
      title: "Повышенный уровень глюкозы",
      text:
        "Ограничьте быстрые углеводы в ближайший приём пищи, добавьте лёгкую физическую активность, если это разрешено вашим планом лечения.",
    };
  }
  return null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry(fn, { retries = 3 } = {}) {
  let attempt = 0;
  let lastErr;
  while (attempt <= retries) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      attempt += 1;
      if (attempt > retries) break;
      await delay(300 * 2 ** attempt);
    }
  }
  throw lastErr;
}

// ============================================================================
// UI-константы
// ============================================================================

const STATUS_META = {
  normal: { label: "Норма", color: "#0F6E56", bg: "#E1F5EE" },
  hypo: { label: "Гипогликемия", color: "#993C1D", bg: "#FAECE7" },
  hyper: { label: "Гипергликемия", color: "#993C1D", bg: "#FAECE7" },
};

function formatTime(iso, rangeKey) {
  const d = new Date(iso);
  if (rangeKey === "7d" || rangeKey === "all") {
    return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
  }
  return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function toCsv(rows) {
  const header = "time,actual_mmol_l,forecast_nn_mmol_l,forecast_ode_mmol_l\n";
  const body = rows
    .map(
      (d) =>
        `${new Date(d.t).toISOString()},${d.actual ?? ""},${d.forecastNN ?? ""},${
          d.forecastODE ?? ""
        }`
    )
    .join("\n");
  return header + body;
}

function downloadCsv(history, patientName) {
  const csv = toCsv(history);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `glucose_${patientName.replace(/\s+/g, "_")}_${Date.now()}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ============================================================================
// Компонент Dashboard
// ============================================================================

function Dashboard({ session, onLogout }) {
  const [patients, setPatients] = useState(
    session.role === "user" ? [{ id: session.id, name: session.name }] : []
  );
  const [patientsLoaded, setPatientsLoaded] = useState(session.role === "user");

  useEffect(() => {
    if (session.role !== "admin") return;
    let cancelled = false;
    fetchPatientsForAdmin(session.id)
      .then((users) => {
        if (cancelled) return;
        setPatients((users || []).map((u) => ({ id: u.ID, name: u.Name })));
        setPatientsLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setPatientsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  const [patientId, setPatientId] = useState(null);

  // Устанавливаем первого пациента только при загрузке списка
  useEffect(() => {
    if (patients.length > 0 && patientId === null) {
      setPatientId(patients[0].id);
    }
  }, [patients]);

  const [rangeKey, setRangeKey] = useState("24h");
  const [connected, setConnected] = useState(true);

  const [snapshot, setSnapshot] = useState(null);
  const [debugOverride, setDebugOverride] = useState("");
  const [nutritionLog, setNutritionLog] = useState([]);
  const [recommendations, setRecommendations] = useState(null); // ✅ Добавлено состояние
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const [whatIf, setWhatIf] = useState({ carbsG: 0, proteinG: 0, activityMin: 0 });
  const [whatIfData, setWhatIfData] = useState({ points: [], netEffect: 0 });
  const [whatIfLoading, setWhatIfLoading] = useState(false);

  // ✅ Состояния для создания пациента администратором
  const [showCreatePatient, setShowCreatePatient] = useState(false);
  const [newPatientName, setNewPatientName] = useState("");
  const [newPatientId, setNewPatientId] = useState("");
  const [creatingPatient, setCreatingPatient] = useState(false);
  const [createPatientError, setCreatePatientError] = useState(null);

  const patient = patients.find((p) => String(p.id) === String(patientId)) || patients[0] || null;
  const pollRef = useRef(null);

  const history = useMemo(() => buildHistory(snapshot?.readings), [snapshot]);
  const latest = useMemo(() => latestReadingFrom(history), [history]);
  const forecastNN = useMemo(
    () => latestForecastFrom(snapshot?.model_predictions),
    [snapshot]
  );
  const forecastODE = useMemo(
    () => latestForecastFrom(snapshot?.odu_predictions),
    [snapshot]
  );
  const futureForecastRows = useMemo(
    () => buildFutureForecastRows(snapshot?.model_predictions, snapshot?.odu_predictions),
    [snapshot]
  );
  const stats = useMemo(() => computeStats(history), [history]);

  const [fullSnapshot, setFullSnapshot] = useState(null);
  useEffect(() => {
    if (!patientId) return;
    let cancelled = false;
    fetchPatientSnapshot(patientId, "all")
      .then((res) => {
        if (!cancelled) setFullSnapshot(res);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [patientId]);
  const fullHistory = useMemo(() => buildHistory(fullSnapshot?.readings), [fullSnapshot]);

  const currentPeriod = RANGE_OPTIONS.find((r) => r.key === rangeKey)?.period || "24h";

  // ✅ ИСПРАВЛЕНО: Загрузка рекомендаций отделена от основных данных
  const loadAll = useCallback(async () => {
    if (!patientId) { setLoading(false); return; }
    try {
      // Загружаем основные данные (глюкоза + питание)
      const [snapshotRes, nutritionRes] = await Promise.all([
        withRetry(() => fetchPatientSnapshot(patientId, currentPeriod)),
        withRetry(() => fetchNutritionLog(patientId)),
      ]);
      setSnapshot(snapshotRes);
      setNutritionLog(nutritionRes);
      setConnected(true);
      setError(null);
    } catch (err) {
      setConnected(false);
      setError("Не удалось получить данные с сервера.");
    }
  
    // Загружаем рекомендации ОТДЕЛЬНО — ошибка не ломает остальное
    try {
      const recommendationsRes = await withRetry(() => fetchRecommendations(patientId));
      setRecommendations(recommendationsRes);
    } catch (err) {
      // Если бэкенд не готов — показываем демо-рекомендации
      setRecommendations({
        nutrition: "Рекомендуется соблюдать режим питания. Ограничьте быстрые углеводы.",
        activity: "Добавьте 30 минут лёгкой физической активности в день.",
        general: "Продолжайте регулярный мониторинг глюкозы.",
      });
    }
  
    setLoading(false);
  }, [patientId, currentPeriod]);

  // ✅ Функция создания пациента
  const handleCreatePatient = async () => {
    if (!newPatientName.trim() || !newPatientId.trim()) {
      setCreatePatientError("Заполните имя и ID пациента");
      return;
    }
    setCreatingPatient(true);
    setCreatePatientError(null);
    try {
      const hospitalId = session.hospitalId;
      const created = await createPatientUser(newPatientId.trim(), newPatientName.trim(), hospitalId);
      setPatients((prev) => [...prev, { id: created.ID, name: created.Name }]);
      setNewPatientName("");
      setNewPatientId("");
      setShowCreatePatient(false);
      setPatientId(created.ID);
    } catch (err) {
      setCreatePatientError("Не удалось создать пациента. Возможно, ID уже занят.");
    } finally {
      setCreatingPatient(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    loadAll();
  }, [loadAll]);

  useEffect(() => {
    pollRef.current = setInterval(async () => {
      if (!patientId) return;
      try {
        const snapshotRes = await fetchPatientSnapshot(patientId, currentPeriod);
        setSnapshot(snapshotRes);
        setConnected(true);
      } catch {
        setConnected(false);
      }
    }, 60000);
    return () => clearInterval(pollRef.current);
  }, [patientId, currentPeriod]);

  const runWhatIf = useCallback(
    async (params) => {
      if (history.length === 0) return;
      setWhatIfLoading(true);
      try {
        const res = await withRetry(() => fetchWhatIfForecast(patientId, params, history));
        setWhatIfData(res);
      } catch {
        // ignore
      } finally {
        setWhatIfLoading(false);
      }
    },
    [patientId, history]
  );

  // ✅ Исправлены зависимости useEffect
  useEffect(() => {
    const t = setTimeout(() => runWhatIf(whatIf), 250);
    return () => clearTimeout(t);
  }, [whatIf, history, runWhatIf]);

  const chartData = useMemo(() => {
    const historyRows = history.map((d) => ({
      t: d.t,
      label: formatTime(d.time, rangeKey),
      actual: d.actual,
      forecastNN: null,
      forecastODE: null,
      whatIf: null,
    }));

    const forecastRows = futureForecastRows.map((d) => ({
      t: d.t,
      label: formatTime(new Date(d.t).toISOString(), rangeKey),
      actual: null,
      forecastNN: d.forecastNN ?? null,
      forecastODE: d.forecastODE ?? null,
      whatIf: null,
    }));

    let rows = [...historyRows, ...forecastRows].sort((a, b) => a.t - b.t);

    // Сценарий "что если"
    const whatIfPoints = whatIfData.points;
    if (historyRows.length > 0 && whatIfPoints.length > 0) {
      const [anchor, ...future] = whatIfPoints;
      const anchorIdx = rows.findIndex((r) => r.t === anchor.t);
      if (anchorIdx !== -1) {
        rows[anchorIdx] = { ...rows[anchorIdx], whatIf: anchor.whatIf };
      }
      const whatIfFutureRows = future.map((d) => ({
        t: d.t,
        label: formatTime(new Date(d.t).toISOString(), rangeKey),
        actual: null,
        forecastNN: null,
        forecastODE: null,
        whatIf: d.whatIf,
      }));
      rows = [...rows, ...whatIfFutureRows].sort((a, b) => a.t - b.t);
    }

    return rows;
  }, [history, futureForecastRows, whatIfData, rangeKey]);

  const yDomain = useMemo(() => {
    const values = chartData.flatMap((d) =>
      [d.actual, d.forecastNN, d.forecastODE, d.whatIf].filter((v) => v != null)
    );
    if (values.length === 0) return [3, 12];
    return [Math.floor(Math.min(...values, 3)) - 0.5, Math.ceil(Math.max(...values, 11)) + 0.5];
  }, [chartData]);

  const displayedLatest = useMemo(() => {
    if (debugOverride === "" || latest == null) return latest;
    const value = Number(debugOverride);
    if (Number.isNaN(value)) return latest;
    return { ...latest, value, status: classify(value) };
  }, [latest, debugOverride]);

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <Header
          patient={patient}
          patients={patients}
          onPatientChange={setPatientId}
          connected={connected}
          session={session}
          onLogout={onLogout}
          onCreatePatient={() => setShowCreatePatient(true)} // ✅ Передача пропа
        />

        {!patientsLoaded ? (
          <div style={styles.emptyState}>Загружаем список пациентов…</div>
        ) : !patient ? (
          <div style={styles.emptyState}>
            В больнице «{session.hospitalName}» пока нет ни одного
            зарегистрированного пациента. Как только кто-то зарегистрируется с
            ролью «Пациент» и укажет эту же больницу, он появится в списке
            здесь.
          </div>
        ) : (
          <>
            {error && (
              <div style={styles.errorBanner}>
                <span>{error}</span>
                <button style={styles.retryBtn} onClick={loadAll}>
                  Повторить
                </button>
              </div>
            )}

            <DebugPanel value={debugOverride} onChange={setDebugOverride} />

            <div style={styles.statusRow}>
              <GlucoseCard latest={displayedLatest} loading={loading} />
              {/* ✅ Вернуты названия моделей */}
              <ForecastCard model={MODELS.nn} forecast={forecastNN} loading={loading} modelStatus={!forecastNN && !loading ? 'training' : undefined} />
              <ForecastCard model={MODELS.ode} forecast={forecastODE} loading={loading} />
            </div>

            {/* ✅ Рекомендации сразу после прогнозов */}
            <RecommendationsPanel recommendations={recommendations} loading={loading} />

            {!loading && displayedLatest && <TipsBanner latest={displayedLatest} />}

            <RangeSelector rangeKey={rangeKey} onChange={setRangeKey} />

            <ChartBlock
              data={chartData}
              yDomain={yDomain}
              rangeKey={rangeKey}
              loading={loading}
              onExport={() => downloadCsv(chartData, patient.name)} // ✅ Исправлена опечатка
              nowLabel={
                history.length ? formatTime(history[history.length - 1].time, rangeKey) : null
              }
            />

            <WhatIfSimulator
              whatIf={whatIf}
              onChange={setWhatIf}
              loading={whatIfLoading}
              netEffect={whatIfData.netEffect}
            />

            <div style={styles.bottomRow}>
              <NutritionLog
                entries={nutritionLog}
                onAdd={(entry) => setNutritionLog((prev) => [...prev, entry])}
              />
              <Statistics stats={stats} loading={loading} />
            </div>

            <FullHistoryTable
              history={fullHistory}
              onExport={() => downloadCsv(fullHistory.map((d) => ({ ...d, forecastNN: null, forecastODE: null })), patient.name)}
            />
          </>
        )}

        {/* ✅ Модальное окно создания пациента */}
        {showCreatePatient && (
          <div style={styles.modalOverlay}>
            <div style={styles.modalContent}>
              <div style={styles.modalHeader}>
                <h3 style={styles.modalTitle}>Создание нового пациента</h3>
                <button style={styles.modalCloseBtn} onClick={() => { setShowCreatePatient(false); setCreatePatientError(null); setNewPatientName(""); setNewPatientId(""); }}>×</button>
              </div>
              <div style={styles.modalBody}>
                {createPatientError && <div style={styles.errorBanner}>{createPatientError}</div>}
                <div style={styles.formGroup}>
                  <label style={styles.formLabel}>Имя пациента</label>
                  <input type="text" value={newPatientName} onChange={(e) => setNewPatientName(e.target.value)} placeholder="Например, Иван Петров" style={styles.formInput} autoFocus />
                </div>
                <div style={styles.formGroup}>
                  <label style={styles.formLabel}>ID пациента <span style={styles.formHint}>(только цифры, 6 знаков, для симулятора)</span></label>
                  <input type="text" value={newPatientId} onChange={(e) => setNewPatientId(e.target.value.replace(/\D/g, ''))} placeholder="Например, 123456" maxLength={6} style={styles.formInput} />
                </div>
                <div style={styles.modalFooter}>
                  <button style={styles.cancelBtn} onClick={() => { setShowCreatePatient(false); setCreatePatientError(null); setNewPatientName(""); setNewPatientId(""); }} disabled={creatingPatient}>Отмена</button>
                  <button style={styles.createBtn} onClick={handleCreatePatient} disabled={creatingPatient || !newPatientName.trim() || !newPatientId.trim()}>
                    {creatingPatient ? "Создание..." : "Создать"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        <Footer />
      </div>
    </div>
  );
}

// ============================================================================
// Подкомпоненты
// ============================================================================

// ✅ Добавлен проп onCreatePatient
function Header({ patient, patients, onPatientChange, connected, session, onLogout, onCreatePatient }) {
  return (
    <div style={styles.header}>
      <div style={styles.logo}>
        <div style={styles.logoMark} />
        <span style={styles.logoText}>Цифровой двойник гликемии</span>
      </div>
      <div style={styles.headerRight}>
        <div style={styles.sessionInfo}>
          <span style={styles.roleBadge}>
            {session.role === "admin" ? "Администратор" : "Пациент"}
          </span>
          <span style={styles.smallMuted}>{session.hospitalName}</span>
          <span style={styles.accountId}>ID: {session.loginId || session.id}</span>
        </div>

        {/* ✅ Кнопка создания пациента для админа */}
        {session.role === "admin" && (
          <button style={styles.createPatientBtn} onClick={onCreatePatient}>+ Создать пациента</button>
        )}

        {session.role === "admin" ? (
          <label style={styles.patientLabel}>
            Пациент:
            {patients.length === 0 ? (
              <span style={styles.smallMuted}> нет пациентов</span>
            ) : (
              <select
                value={String(patient?.id ?? "")} // ✅ Приведение к строке
                onChange={(e) => onPatientChange(e.target.value)}
                style={styles.select}
              >
                {patients.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
          </label>
        ) : (
          <span style={styles.patientLabel}>{patient?.name}</span>
        )}

        <div style={styles.connectionIndicator}>
          <span
            style={{
              ...styles.connectionDot,
              background: connected ? "#0F6E56" : "#993C1D",
            }}
          />
          {connected ? "Подключено" : "Нет соединения"}
        </div>

        <button style={styles.logoutBtn} onClick={onLogout}>
          Выйти
        </button>
      </div>
    </div>
  );
}

function DebugPanel({ value, onChange }) {
  return (
    <div style={styles.debugPanel}>
      <span style={styles.debugLabel}>Тест: подставить уровень глюкозы</span>
      <input
        type="number"
        step="0.1"
        placeholder="напр. 3.2 или 11.5"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={styles.debugInput}
      />
      <span style={styles.debugHint}>
        {"< 3.9 — гипо, > 10.0 — гипер, между — норма"}
      </span>
      {value !== "" && (
        <button style={styles.debugReset} onClick={() => onChange("")}>
          Сбросить
        </button>
      )}
    </div>
  );
}

function GlucoseCard({ latest, loading }) {
  const meta = latest ? STATUS_META[latest.status] : null;
  return (
    <div style={styles.statCard}>
      <div style={styles.statCardLabel}>Текущая глюкоза</div>
      {loading || !latest ? (
        <div style={styles.skeleton} />
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <span style={styles.bigValue}>{latest.value} ммоль/л</span>
            <span
              style={{
                ...styles.badge,
                color: meta.color,
                background: meta.bg,
              }}
            >
              {meta.label}
            </span>
          </div>
          <div style={styles.smallMuted}>
            {new Date(latest.measuredAt).toLocaleTimeString("ru-RU", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ✅ Вернуты названия моделей в карточках
function ForecastCard({ model, forecast, loading, modelStatus }) {
  return (
    <div style={styles.statCard}>
      <div style={styles.statCardLabel}>
        Прогноз
        <span style={{ ...styles.modelTag, color: model.color }}>
          {" "}· {model.label}
        </span>
      </div>
      {loading ? (
        <div style={styles.skeleton} />
      ) : !forecast && modelStatus === 'training' ? (
        <>
          <span style={{ ...styles.bigValue, fontSize: 16, color: "#898781" }}>Ожидаю обучение</span>
          <div style={styles.smallMuted}>Модель ещё не готова к прогнозам</div>
        </>
      ) : !forecast && modelStatus === 'not_ready' ? (
        <>
          <span style={{ ...styles.bigValue, fontSize: 16, color: "#898781" }}>Не готов</span>
          <div style={styles.smallMuted}>Нет данных для прогноза</div>
        </>
      ) : !forecast ? (
        <div style={styles.skeleton} />
      ) : (
        <>
          <span style={styles.bigValue}>{forecast.value} ммоль/л</span>
          <div style={styles.smallMuted}>
            на{" "}
            {new Date(forecast.forecastFor).toLocaleTimeString("ru-RU", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </div>
        </>
      )}
    </div>
  );
}

function TipsBanner({ latest }) {
  const tip = getGlucoseTips(latest.value, latest.status);
  if (!tip) return null;

  const palette =
    tip.severity === "critical"
      ? { color: "#712B13", bg: "#FAECE7", border: "#E5A188" }
      : { color: "#8A5A12", bg: "#FBF2E1", border: "#E6C27A" };

  return (
    <div
      style={{
        ...styles.tipsBanner,
        background: palette.bg,
        borderColor: palette.border,
      }}
    >
      <div style={{ ...styles.tipsTitle, color: palette.color }}>{tip.title}</div>
      <div style={{ ...styles.tipsText, color: palette.color }}>{tip.text}</div>
      <div style={styles.tipsDisclaimer}>
        Общая информация, не заменяет назначения врача.
      </div>
    </div>
  );
}

function RangeSelector({ rangeKey, onChange }) {
  return (
    <div style={styles.rangeRow}>
      {RANGE_OPTIONS.map((opt) => (
        <button
          key={opt.key}
          onClick={() => onChange(opt.key)}
          style={{
            ...styles.rangeBtn,
            ...(rangeKey === opt.key ? styles.rangeBtnActive : {}),
          }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function ChartBlock({ data, yDomain, rangeKey, loading, onExport, nowLabel }) {
  const lastLabel = data.length ? data[data.length - 1].label : null;
  const hasScenario = nowLabel && lastLabel && nowLabel !== lastLabel;

  return (
    <div style={styles.chartBlock}>
      <div style={styles.chartHeaderRow}>
        <Legend />
        <button style={styles.exportBtn} onClick={onExport} disabled={loading}>
          Экспорт в CSV
        </button>
      </div>
      <div style={{ width: "100%", height: 260 }}>
        <ResponsiveContainer>
          <ComposedChart data={data} margin={{ top: 24, right: 10, left: -10, bottom: 0 }}>
            <CartesianGrid stroke="#e1e0d9" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: "#898781" }}
              minTickGap={30}
              axisLine={{ stroke: "#c3c2b7" }}
              tickLine={false}
            />
            <YAxis
              domain={yDomain}
              tick={{ fontSize: 11, fill: "#898781" }}
              axisLine={false}
              tickLine={false}
              width={36}
            />
            <ReferenceArea
              y1={TARGET_RANGE.low}
              y2={TARGET_RANGE.high}
              fill="#5DCAA5"
              fillOpacity={0.12}
              ifOverflow="extendDomain"
            />
            {hasScenario && (
              <ReferenceArea
                x1={nowLabel}
                x2={lastLabel}
                fill="#F2A340"
                fillOpacity={0.14}
                ifOverflow="extendDomain"
                label={{
                  value: "Сценарий «что если»",
                  position: "insideTop",
                  fontSize: 11,
                  fill: "#8A5A12",
                }}
              />
            )}
            {nowLabel && (
              <ReferenceLine
                x={nowLabel}
                stroke="#898781"
                strokeDasharray="3 3"
                label={{ value: "Сейчас", position: "top", fontSize: 11, fill: "#52514e" }}
              />
            )}
            <Tooltip
              formatter={(value, name) => {
                return [
                  value == null ? "—" : `${value} ммоль/л`,
                  {
                    actual: "Факт",
                    forecastNN: "Прогноз (нейросеть)",
                    forecastODE: "Прогноз (ОДУ)",
                    whatIf: "Что если",
                  }[name] || name,
                ];
              }}
              contentStyle={{ fontSize: 12, borderRadius: 8 }}
            />
            <Area
              type="monotone"
              dataKey="actual"
              stroke="#185FA5"
              strokeWidth={2}
              fill="#85B7EB"
              fillOpacity={0.25}
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="forecastNN"
              stroke={MODELS.nn.color}
              strokeWidth={2}
              strokeDasharray="5 4"
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="forecastODE"
              stroke={MODELS.ode.color}
              strokeWidth={2}
              strokeDasharray="5 4"
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="whatIf"
              stroke="#C2410C"
              strokeWidth={3}
              dot={{ r: 4, fill: "#C2410C", stroke: "#fff", strokeWidth: 1 }}
              connectNulls
              isAnimationActive={false}
              label={{
                position: "top",
                fontSize: 11,
                fill: "#C2410C",
                formatter: (v) => (v == null ? "" : v.toFixed(1)),
              }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function Legend() {
  const items = [
    { color: "#185FA5", label: "Факт", dash: false },
    { color: MODELS.nn.color, label: `Прогноз: ${MODELS.nn.label}`, dash: true },
    { color: MODELS.ode.color, label: `Прогноз: ${MODELS.ode.label}`, dash: true },
    { color: "#C2410C", label: "Сценарий «что если»", dash: false },
    { color: "#5DCAA5", label: "Целевой диапазон", swatch: true },
  ];
  return (
    <div style={styles.legendRow}>
      {items.map((it) => (
        <span key={it.label} style={styles.legendItem}>
          <span
            style={{
              ...styles.legendMark,
              background: it.swatch ? it.color : "transparent",
              borderTop: it.swatch ? "none" : `2px ${it.dash ? "dashed" : "solid"} ${it.color}`,
              opacity: it.swatch ? 0.3 : 1,
            }}
          />
          {it.label}
        </span>
      ))}
    </div>
  );
}

function WhatIfSimulator({ whatIf, onChange, loading, netEffect }) {
  const set = (key) => (e) => onChange({ ...whatIf, [key]: Number(e.target.value) });
  const effectColor = netEffect > 0.05 ? "#993C1D" : netEffect < -0.05 ? "#0F6E56" : "#52514e";
  return (
    <div style={styles.whatIfBlock}>
      <div style={styles.whatIfHeader}>
        Симулятор «что если»
        {loading && <span style={styles.smallMuted}> · пересчёт…</span>}
      </div>
      <div style={{ ...styles.effectReadout, color: effectColor }}>
        Ожидаемый эффект: {netEffect > 0 ? "+" : ""}
        {netEffect.toFixed(1)} ммоль/л к концу сценария
      </div>
      <div style={styles.slidersRow}>
        <SliderField
          label="Углеводы"
          unit="г"
          min={-30}
          max={60}
          value={whatIf.carbsG}
          onChange={set("carbsG")}
        />
        <SliderField
          label="Белки"
          unit="г"
          min={-20}
          max={40}
          value={whatIf.proteinG}
          onChange={set("proteinG")}
        />
        <SliderField
          label="Активность"
          unit="мин"
          min={0}
          max={60}
          value={whatIf.activityMin}
          onChange={set("activityMin")}
        />
      </div>
    </div>
  );
}

function SliderField({ label, unit, min, max, value, onChange }) {
  return (
    <div style={styles.sliderField}>
      <div style={styles.sliderLabelRow}>
        <span>{label}</span>
        <span style={styles.sliderValue}>
          {value > 0 ? "+" : ""}
          {value} {unit}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={onChange}
        style={{ width: "100%" }}
      />
    </div>
  );
}

function NutritionLog({ entries, onAdd }) {
  return (
    <div style={styles.panel}>
      <div style={styles.panelTitle}>Журнал питания</div>

      <NutritionEntryForm onAdd={onAdd} />

      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>Время</th>
            <th style={styles.th}>Продукт</th>
            <th style={styles.th}>Граммы</th>
            <th style={styles.th}>Ккал</th>
            <th style={styles.th}>Б/Ж/У</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id}>
              <td style={styles.td}>{e.time}</td>
              <td style={styles.td}>{e.food}</td>
              <td style={styles.td}>{e.grams} г</td>
              <td style={styles.td}>{e.calories}</td>
              <td style={styles.td}>
                {e.protein}/{e.fat}/{e.carbs}
              </td>
            </tr>
          ))}
          {entries.length === 0 && (
            <tr>
              <td style={styles.td} colSpan={5}>
                Записей пока нет — добавьте первый приём пищи выше.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function NutritionEntryForm({ onAdd }) {
  const [query, setQuery] = useState("");
  const [selectedFood, setSelectedFood] = useState(null);
  const [grams, setGrams] = useState(150);

  const matches = useMemo(() => findFoodMatches(query), [query]);
  const preview = selectedFood ? computeMacros(selectedFood, grams) : null;

  const handlePick = (food) => {
    setSelectedFood(food);
    setQuery(food.name);
  };

  const handleAdd = () => {
    if (!selectedFood || !grams || grams <= 0) return;
    const macros = computeMacros(selectedFood, grams);
    onAdd({
      id: `n-${Date.now()}`,
      time: new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }),
      food: selectedFood.name,
      grams,
      ...macros,
    });
    setQuery("");
    setSelectedFood(null);
    setGrams(150);
  };

  return (
    <div style={styles.nutritionForm}>
      <div style={styles.nutritionFormRow}>
        <div style={{ position: "relative", flex: 2 }}>
          <input
            type="text"
            placeholder="Название продукта (напр. Гречка)"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedFood(null);
            }}
            style={styles.nutritionInput}
          />
          {query && !selectedFood && matches.length > 0 && (
            <div style={styles.suggestList}>
              {matches.map((f) => (
                <div key={f.name} style={styles.suggestItem} onClick={() => handlePick(f)}>
                  {f.name}
                  <span style={styles.smallMuted}> · {f.calories} ккал/100г</span>
                </div>
              ))}
            </div>
          )}
          {query && !selectedFood && matches.length === 0 && query.trim().length >= 2 && (
            <div style={styles.suggestEmpty}>Не найдено в базе продуктов</div>
          )}
        </div>
        <input
          type="number"
          min={1}
          value={grams}
          onChange={(e) => setGrams(Number(e.target.value))}
          style={styles.nutritionGramsInput}
        />
        <span style={styles.smallMuted}>г</span>
        <button
          style={styles.nutritionAddBtn}
          onClick={handleAdd}
          disabled={!selectedFood}
        >
          Добавить
        </button>
      </div>
      {preview && (
        <div style={styles.nutritionPreview}>
          {preview.calories} ккал · Б {preview.protein} г · Ж {preview.fat} г · У{" "}
          {preview.carbs} г
        </div>
      )}
    </div>
  );
}

function Statistics({ stats, loading }) {
  return (
    <div style={styles.panel}>
      <div style={styles.panelTitle}>Статистика</div>
      {loading || !stats ? (
        <div style={styles.skeleton} />
      ) : (
        <div style={styles.statsGrid}>
          <StatRow label="Среднее" value={`${stats.average} ммоль/л`} />
          <StatRow label="Мин" value={`${stats.min} ммоль/л`} />
          <StatRow label="Макс" value={`${stats.max} ммоль/л`} />
          <StatRow label="Время в диапазоне" value={`${stats.timeInRange}%`} />
        </div>
      )}
    </div>
  );
}

// ✅ Компонент рекомендаций
function RecommendationsPanel({ recommendations, loading }) {
  if (loading) {
    return (
      <div style={styles.panel}>
        <div style={styles.panelTitle}>Рекомендации</div>
        <div style={styles.skeleton} />
      </div>
    );
  }
  if (!recommendations) {
    return (
      <div style={styles.panel}>
        <div style={styles.panelTitle}>Рекомендации</div>
        <div style={styles.smallMuted}>Нет рекомендаций</div>
      </div>
    );
  }
  const items = Array.isArray(recommendations)
    ? recommendations
    : Object.entries(recommendations).map(([key, value]) => ({ type: key, text: value }));
  const typeLabels = { nutrition: "🍎 Питание", activity: "🏃 Активность", insulin: "💉 Инсулин", general: " Общие", monitoring: "📊 Мониторинг" };
  return (
    <div style={styles.panel}>
      <div style={styles.panelTitle}>Рекомендации</div>
      <div style={styles.recommendationsList}>
        {items.map((item, index) => (
          <div key={index} style={styles.recommendationItem}>
            <div style={styles.recommendationType}>{typeLabels[item.type] || item.type}</div>
            <div style={styles.recommendationText}>{item.text}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatRow({ label, value }) {
  return (
    <div style={styles.statRow}>
      <span style={styles.smallMuted}>{label}</span>
      <span style={{ fontWeight: 500 }}>{value}</span>
    </div>
  );
}

function FullHistoryTable({ history, onExport }) {
  const [open, setOpen] = useState(false);
  const sorted = useMemo(() => [...history].sort((a, b) => b.t - a.t), [history]);

  return (
    <div style={styles.panel}>
      <div style={styles.historyHeaderRow}>
        <button style={styles.historyToggleBtn} onClick={() => setOpen((v) => !v)}>
          {open ? "▾" : "▸"} История измерений ({history.length})
        </button>
        <button style={styles.exportBtn} onClick={onExport}>
          Экспорт в CSV
        </button>
      </div>
      {open && (
        <div style={styles.historyScroll}>
          {sorted.length === 0 ? (
            <div style={styles.smallMuted}>Измерений пока нет.</div>
          ) : (
            <table style={styles.table}>
              <thead>
                <tr><th style={styles.th}>Дата</th><th style={styles.th}>Время</th><th style={styles.th}>Глюкоза</th><th style={styles.th}>Статус</th></tr>
              </thead>
              <tbody>
                {sorted.map((d) => {
                  const dt = new Date(d.t);
                  const status = d.actual != null ? classify(d.actual) : null;
                  const meta = status ? STATUS_META[status] : null;
                  return (
                    <tr key={d.t}>
                      <td style={styles.td}>{dt.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" })}</td>
                      <td style={styles.td}>{dt.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</td>
                      <td style={styles.td}>{d.actual != null ? `${d.actual} ммоль/л` : "—"}</td>
                      <td style={styles.td}>{meta && <span style={{ ...styles.badge, color: meta.color, background: meta.bg }}>{meta.label}</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

function Footer() {
  return (
    <div style={styles.footer}>
      <span>Версия клиента: 0.1.0</span>
      <a href="#" style={styles.footerLink}>
        Документация
      </a>
    </div>
  );
}

// ============================================================================
// Стили
// ============================================================================

const styles = {
  page: { minHeight: "100vh", background: "#EEF0F3", padding: "32px 16px", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif", display: "flex", justifyContent: "center" },
  card: { width: "100%", maxWidth: 960, background: "#ffffff", borderRadius: 20, padding: 28, boxSizing: "border-box" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 20 },
  logo: { display: "flex", alignItems: "center", gap: 8 },
  logoMark: { width: 26, height: 26, borderRadius: 8, background: "linear-gradient(135deg, #185FA5, #0F6E56)" },
  logoText: { fontWeight: 500, fontSize: 16, color: "#0b0b0b" },
  headerRight: { display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" },
  sessionInfo: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 },
  roleBadge: { fontSize: 12, fontWeight: 600, color: "#0C447C", background: "#E7F0FA", borderRadius: 999, padding: "2px 10px" },
  logoutBtn: { border: "1px solid #d3d1c7", background: "#fff", borderRadius: 8, padding: "6px 12px", fontSize: 12, cursor: "pointer", color: "#52514e" },
  patientLabel: { fontSize: 13, color: "#52514e", display: "flex", alignItems: "center", gap: 8 },
  select: { padding: "6px 10px", borderRadius: 8, border: "1px solid #d3d1c7", fontSize: 13, background: "#fff" },
  connectionIndicator: { display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#52514e" },
  connectionDot: { width: 8, height: 8, borderRadius: "50%" },
  debugPanel: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", background: "#F1EFE8", border: "1px dashed #c3c2b7", borderRadius: 10, padding: "8px 12px", marginBottom: 16, fontSize: 12 },
  debugLabel: { color: "#52514e", fontWeight: 500 },
  debugInput: { width: 130, padding: "4px 8px", borderRadius: 6, border: "1px solid #d3d1c7", fontSize: 12 },
  debugHint: { color: "#898781" },
  debugReset: { border: "1px solid #d3d1c7", background: "#fff", borderRadius: 6, padding: "3px 10px", fontSize: 12, cursor: "pointer" },
  emptyState: { background: "#F7F6F2", border: "1px dashed #c3c2b7", borderRadius: 10, padding: "20px 16px", fontSize: 13, color: "#52514e", textAlign: "center" },
  errorBanner: { display: "flex", justifyContent: "space-between", alignItems: "center", background: "#FAECE7", color: "#712B13", padding: "10px 14px", borderRadius: 10, fontSize: 13, marginBottom: 16 },
  retryBtn: { border: "1px solid #993C1D", background: "transparent", color: "#712B13", borderRadius: 6, padding: "4px 10px", fontSize: 12, cursor: "pointer" },
  statusRow: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, marginBottom: 20 },
  statCard: { border: "1px solid #e1e0d9", borderRadius: 14, padding: "16px 18px", minHeight: 74 },
  statCardLabel: { fontSize: 12, color: "#898781", marginBottom: 6 },
  modelTag: { fontSize: 12, fontWeight: 600 },
  bigValue: { fontSize: 22, fontWeight: 500, color: "#0b0b0b" },
  badge: { fontSize: 12, fontWeight: 500, padding: "3px 10px", borderRadius: 999 },
  smallMuted: { fontSize: 12, color: "#898781", marginTop: 4 },
  skeleton: { height: 34, borderRadius: 6, background: "#f1efe8" },
  tipsBanner: { border: "1px solid", borderRadius: 12, padding: "12px 16px", marginBottom: 16 },
  tipsTitle: { fontSize: 13, fontWeight: 600, marginBottom: 4 },
  tipsText: { fontSize: 13, lineHeight: 1.4 },
  tipsDisclaimer: { fontSize: 11, color: "#898781", marginTop: 6, fontStyle: "italic" },
  rangeRow: { display: "flex", gap: 8, marginBottom: 16 },
  rangeBtn: { border: "1px solid #d3d1c7", background: "#fff", borderRadius: 999, padding: "6px 16px", fontSize: 13, cursor: "pointer", color: "#52514e" },
  rangeBtnActive: { background: "#0C447C", borderColor: "#0C447C", color: "#fff" },
  chartBlock: { marginBottom: 24 },
  chartHeaderRow: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 8 },
  legendRow: { display: "flex", gap: 14, flexWrap: "wrap" },
  legendItem: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#52514e" },
  legendMark: { width: 16, height: 10, borderRadius: 3 },
  exportBtn: { border: "1px solid #d3d1c7", background: "#fff", borderRadius: 8, padding: "6px 12px", fontSize: 12, cursor: "pointer", color: "#0b0b0b" },
  whatIfBlock: { border: "1px solid #e1e0d9", borderRadius: 14, padding: "16px 18px", marginBottom: 24 },
  whatIfHeader: { fontSize: 14, fontWeight: 500, marginBottom: 12 },
  effectReadout: { fontSize: 13, fontWeight: 600, marginBottom: 14 },
  slidersRow: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 20 },
  sliderField: {},
  sliderLabelRow: { display: "flex", justifyContent: "space-between", fontSize: 13, color: "#52514e", marginBottom: 6 },
  sliderValue: { fontWeight: 500, color: "#0b0b0b" },
  bottomRow: { display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 20, marginBottom: 20 },
  panel: { border: "1px solid #e1e0d9", borderRadius: 14, padding: "16px 18px", marginBottom: 20 },
  panelTitle: { fontSize: 14, fontWeight: 500, marginBottom: 12 },
  historyHeaderRow: { display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 },
  historyToggleBtn: { border: "none", background: "transparent", fontSize: 14, fontWeight: 500, cursor: "pointer", color: "#0b0b0b", padding: 0 },
  historyScroll: { marginTop: 14, maxHeight: 320, overflowY: "auto", border: "1px solid #f1efe8", borderRadius: 8, padding: "0 12px" },
  nutritionForm: { background: "#F7F6F2", border: "1px solid #e1e0d9", borderRadius: 10, padding: "10px 12px", marginBottom: 14 },
  nutritionFormRow: { display: "flex", gap: 8, alignItems: "center" },
  nutritionInput: { width: "100%", padding: "6px 10px", borderRadius: 6, border: "1px solid #d3d1c7", fontSize: 13, boxSizing: "border-box" },
  nutritionGramsInput: { width: 64, padding: "6px 8px", borderRadius: 6, border: "1px solid #d3d1c7", fontSize: 13 },
  nutritionAddBtn: { border: "none", background: "#0C447C", color: "#fff", borderRadius: 6, padding: "7px 14px", fontSize: 13, cursor: "pointer", whiteSpace: "nowrap" },
  nutritionPreview: { marginTop: 8, fontSize: 12, color: "#0F6E56", fontWeight: 500 },
  suggestList: { position: "absolute", top: "100%", left: 0, right: 0, background: "#fff", border: "1px solid #d3d1c7", borderRadius: 8, marginTop: 4, zIndex: 5, boxShadow: "0 4px 12px rgba(0,0,0,0.08)", maxHeight: 200, overflowY: "auto" },
  suggestItem: { padding: "8px 12px", fontSize: 13, cursor: "pointer", borderBottom: "1px solid #f1efe8" },
  suggestEmpty: { position: "absolute", top: "100%", left: 0, right: 0, background: "#fff", border: "1px solid #d3d1c7", borderRadius: 8, marginTop: 4, padding: "8px 12px", fontSize: 12, color: "#898781", zIndex: 5 },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", color: "#898781", fontWeight: 500, fontSize: 12, paddingBottom: 8 },
  td: { padding: "8px 0", borderTop: "1px solid #f1efe8" },
  matchBadge: { fontSize: 11, padding: "3px 8px", borderRadius: 999, whiteSpace: "nowrap" },
  statsGrid: { display: "flex", flexDirection: "column", gap: 10 },
  statRow: { display: "flex", justifyContent: "space-between", fontSize: 13 },
  footer: { display: "flex", justifyContent: "space-between", fontSize: 12, color: "#898781", borderTop: "1px solid #f1efe8", paddingTop: 14 },
  footerLink: { color: "#185FA5", textDecoration: "none" },
  formLabel: { fontSize: 13, fontWeight: 500, marginBottom: 6, color: "#52514e" },
  authTabsRow: { display: "flex", gap: 4, marginTop: 16, marginBottom: 12, background: "#F1EFE8", borderRadius: 10, padding: 4 },
  authTab: { flex: 1, border: "none", background: "transparent", borderRadius: 8, padding: "8px 0", fontSize: 13, cursor: "pointer", color: "#52514e" },
  authTabActive: { background: "#fff", color: "#0b0b0b", fontWeight: 500, boxShadow: "0 1px 3px rgba(0,0,0,0.08)" },
  accountList: { display: "flex", flexDirection: "column", gap: 8, marginTop: 14 },
  accountItem: { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2, textAlign: "left", border: "1px solid #d3d1c7", borderRadius: 10, padding: "10px 14px", background: "#fff", cursor: "pointer", fontSize: 13 },
  accountId: { fontSize: 11, color: "#898781", fontFamily: "monospace", marginTop: 2, wordBreak: "break-all" },
  recommendationsList: { display: "flex", flexDirection: "column", gap: 12 },
  recommendationItem: { background: "#F7F6F2", border: "1px solid #e1e0d9", borderRadius: 10, padding: "12px 14px" },
  recommendationType: { fontSize: 12, fontWeight: 600, color: "#0C447C", marginBottom: 6 },
  recommendationText: { fontSize: 13, lineHeight: 1.5, color: "#52514e" },
  loginIdDisplay: { fontFamily: "monospace", fontSize: 20, fontWeight: 600, background: "#F1EFE8", border: "1px dashed #c3c2b7", borderRadius: 10, padding: "12px 16px", marginTop: 6, marginBottom: 10, textAlign: "center", wordBreak: "break-all" },
  roleRow: { display: "flex", flexDirection: "column", gap: 8 },
  radioLabel: { display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#0b0b0b", cursor: "pointer" },
  createPatientBtn: { background: "#0F6E56", color: "#fff", border: "none", borderRadius: 8, padding: "6px 12px", fontSize: 12, cursor: "pointer", fontWeight: 500, marginLeft: 8 },
  modalOverlay: { position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 },
  modalContent: { background: "#fff", borderRadius: 16, padding: 24, width: "90%", maxWidth: 440, boxShadow: "0 8px 32px rgba(0,0,0,0.2)" },
  modalHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 },
  modalTitle: { margin: 0, fontSize: 18, fontWeight: 600, color: "#0b0b0b" },
  modalCloseBtn: { background: "none", border: "none", fontSize: 28, cursor: "pointer", color: "#898781", lineHeight: 1, padding: 0 },
  modalBody: {},
  formGroup: { marginBottom: 16 },
  formHint: { fontSize: 11, color: "#898781", fontWeight: 400, marginLeft: 6 },
  formInput: { width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid #d3d1c7", fontSize: 14, marginTop: 6, boxSizing: "border-box" },
  modalFooter: { display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 24 },
  cancelBtn: { background: "#fff", border: "1px solid #d3d1c7", borderRadius: 8, padding: "10px 20px", fontSize: 14, cursor: "pointer", color: "#52514e" },
  createBtn: { background: "#0F6E56", border: "none", borderRadius: 8, padding: "10px 20px", fontSize: 14, cursor: "pointer", color: "#fff", fontWeight: 500 },
};

// ============================================================================
// Экран регистрации/входа
// ============================================================================

function RegisterScreen({ onRegistered }) {
  const [mode, setMode] = useState("register");
  const [name, setName] = useState("");
  const [role, setRole] = useState("user");
  const [hospitalQuery, setHospitalQuery] = useState("");
  const [hospitalMatches, setHospitalMatches] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [loginIdInput, setLoginIdInput] = useState("");
  const [justRegistered, setJustRegistered] = useState(null);
  const [hasExactHospitalMatch, setHasExactHospitalMatch] = useState(false);
  const hospitalInputRef = useRef(null);

  useEffect(() => {
    const q = hospitalQuery.trim();
    if (q.length < 1) { setHospitalMatches([]); setHasExactHospitalMatch(false); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      fetchAllHospitals()
        .then((all) => {
          if (cancelled) return;
          const filtered = (all || []).filter((h) => h.Name.toLowerCase().includes(q.toLowerCase()));
          setHospitalMatches(filtered.slice(0, 5));
          setHasExactHospitalMatch(filtered.some((h) => h.Name.trim().toLowerCase() === q.toLowerCase()));
        })
        .catch(() => { if (!cancelled) { setHospitalMatches([]); setHasExactHospitalMatch(false); } });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [hospitalQuery]);

  // ✅ Исправлены зависимости useEffect для клика вне
  useEffect(() => {
    function handleClickOutside(event) {
      if (hospitalInputRef.current && !hospitalInputRef.current.contains(event.target)) {
        setHospitalMatches([]);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => { document.removeEventListener("mousedown", handleClickOutside); };
  }, []);

  const isNewHospital = hospitalQuery.trim().length > 0 && !hasExactHospitalMatch;

  const handleRegister = async () => {
    setError(null);
    if (role === "user" && !name.trim()) { setError("Введите имя."); return; }
    if (!hospitalQuery.trim()) { setError("Укажите больницу."); return; }
    setSubmitting(true);
    try {
      const hospital = await withRetry(() => findOrCreateHospital(hospitalQuery));
      let session;
      if (role === "admin") {
        const admin = await withRetry(() => createAdminUser(hospital.ID));
        session = { id: admin.ID, loginId: admin.ID, name: null, role: "admin", hospitalId: hospital.ID, hospitalName: hospital.Name };
      } else {
        let created = null; let lastErr = null;
        for (let attempt = 0; attempt < 3 && !created; attempt++) {
          try { const id = genPatientId(); created = await createPatientUser(id, name.trim(), hospital.ID); }
          catch (e) { lastErr = e; }
        }
        if (!created) throw lastErr || new Error("network");
        session = { id: created.ID, loginId: created.ID, name: created.Name, role: "user", hospitalId: hospital.ID, hospitalName: hospital.Name };
      }
      setJustRegistered(session);
    } catch (err) { setError("Не удалось зарегистрироваться — бэкенд недоступен."); }
    finally { setSubmitting(false); }
  };

  const handleLoginSubmit = async () => {
    setError(null);
    const raw = loginIdInput.trim();
    if (!raw) { setError("Введите ID."); return; }
    setSubmitting(true);
    try {
      if (/^\d+$/.test(raw)) {
        const user = await fetchPatientUser(raw);
        const hospitalName = await resolveHospitalName(user.HospitalID);
        onRegistered({ id: user.ID, loginId: user.ID, name: user.Name, role: "user", hospitalId: fromNullUUID(user.HospitalID), hospitalName: hospitalName || "—" });
      } else {
        const admin = await fetchAdmin(raw);
        const hospitalName = await resolveHospitalName(admin.HospitalID);
        onRegistered({ id: admin.ID, loginId: admin.ID, name: null, role: "admin", hospitalId: fromNullUUID(admin.HospitalID), hospitalName: hospitalName || "—" });
      }
    } catch (err) { setError("Пользователь с таким ID не найден."); }
    finally { setSubmitting(false); }
  };

  if (justRegistered) {
    return (
      <div style={styles.page}>
        <div style={{ ...styles.card, maxWidth: 440 }}>
          <div style={styles.logo}><div style={styles.logoMark} /><span style={styles.logoText}>Цифровой двойник гликемии</span></div>
          <p style={styles.smallMuted}>Регистрация прошла успешно.</p>
          <div style={styles.formLabel}>{justRegistered.role === "admin" ? "Ваш ID администратора" : "Ваш ID пациента"}</div>
          <div style={styles.loginIdDisplay}>{justRegistered.loginId}</div>
          <p style={styles.smallMuted}>Сохраните этот ID — он понадобится, чтобы войти в следующий раз.</p>
          <button style={{ ...styles.nutritionAddBtn, width: "100%", marginTop: 20, padding: "10px 0" }} onClick={() => onRegistered(justRegistered)}>Продолжить</button>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <div style={{ ...styles.card, maxWidth: 440 }}>
        <div style={styles.logo}><div style={styles.logoMark} /><span style={styles.logoText}>Цифровой двойник гликемии</span></div>
        <div style={styles.authTabsRow}>
          <button style={{ ...styles.authTab, ...(mode === "register" ? styles.authTabActive : {}) }} onClick={() => { setMode("register"); setError(null); }}>Зарегистрироваться</button>
          <button style={{ ...styles.authTab, ...(mode === "login" ? styles.authTabActive : {}) }} onClick={() => { setMode("login"); setError(null); }}>Войти</button>
        </div>
        {error && <div style={styles.errorBanner}>{error}</div>}
        {mode === "login" ? (
          <>
            <p style={styles.smallMuted}>Пациенты входят по короткому числовому ID, администраторы — по UUID.</p>
            <div style={{ marginTop: 12 }}>
              <div style={styles.formLabel}>Ваш ID</div>
              <input type="text" value={loginIdInput} onChange={(e) => setLoginIdInput(e.target.value)} placeholder="Например, 482913 или UUID" style={styles.nutritionInput} />
            </div>
            <button style={{ ...styles.nutritionAddBtn, width: "100%", marginTop: 16, padding: "10px 0" }} onClick={handleLoginSubmit}>Войти</button>
          </>
        ) : (
          <>
            <p style={styles.smallMuted}>Регистрация нужна один раз — дальше вход будет запоминаться в этом браузере.</p>
            {role === "user" && (
              <div style={{ marginTop: 16 }}>
                <div style={styles.formLabel}>Имя</div>
                <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Например, Мария Иванова" style={styles.nutritionInput} />
              </div>
            )}
            <div style={{ marginTop: 14 }}>
              <div style={styles.formLabel}>Роль</div>
              <div style={styles.roleRow}>
                <label style={styles.radioLabel}><input type="radio" checked={role === "user"} onChange={() => setRole("user")} /> Пациент</label>
                <label style={styles.radioLabel}><input type="radio" checked={role === "admin"} onChange={() => setRole("admin")} /> Администратор</label>
              </div>
            </div>
            <div style={{ marginTop: 14, position: "relative" }} ref={hospitalInputRef}>
              <div style={styles.formLabel}>Больница</div>
              <input type="text" value={hospitalQuery} onChange={(e) => setHospitalQuery(e.target.value)} placeholder="Начните вводить название" style={styles.nutritionInput} />
              {hospitalQuery && hospitalMatches.length > 0 && (
                <div style={styles.suggestList}>
                  {hospitalMatches.map((h) => (
                    <div key={h.ID} style={styles.suggestItem} onClick={() => { setHospitalQuery(h.Name); setHospitalMatches([]); }}>{h.Name}</div>
                  ))}
                </div>
              )}
              {isNewHospital && <div style={styles.smallMuted}>Такой больницы ещё нет — будет создана новая: «{hospitalQuery.trim()}»</div>}
            </div>
            <button style={{ ...styles.nutritionAddBtn, width: "100%", marginTop: 20, padding: "10px 0" }} onClick={handleRegister} disabled={submitting}>
              {submitting ? "Регистрируем..." : "Зарегистрироваться"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Корневой компонент
// ============================================================================

export default function GlucoseDashboardApp() {
  const [session, setSession] = useState(() => loadSession());

  if (!session) {
    return <RegisterScreen onRegistered={(s) => { saveSession(s); setSession(s); }} />;
  }

  return <Dashboard session={session} onLogout={() => { clearSession(); setSession(null); }} />;
}
