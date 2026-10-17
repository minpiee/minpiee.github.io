const FOCUS_BACKGROUNDS = [
  "backgrounds/bg1.jpg",
  "backgrounds/bg2.jpg",
  "backgrounds/bg3.jpg",
  "backgrounds/bg4.jpg",
  "backgrounds/bg5.jpg",
  "backgrounds/bg6.jpg",
  "backgrounds/bg7.jpg",
  "backgrounds/bg8.jpg",
  "backgrounds/bg9.jpg",
  "backgrounds/bg10.jpg",
];

const BREAK_BACKGROUNDS = ["backgrounds/break.jpg"];

let currentFocusBg = -1;
let currentBreakBg = -1;
let backgroundChangeTimer = null;

const bg = document.getElementById("bg");
const timeEl = document.getElementById("time");
const totalFocusEl = document.getElementById("totalFocus");
const progress = document.getElementById("progress");
const toast = document.getElementById("toast");
const timerContent = document.getElementById("timerContent");
const settingsContent = document.getElementById("settingsContent");
const focusInput = document.getElementById("focusInput");
const breakInput = document.getElementById("breakInput");
const longBreakInput = document.getElementById("longBreakInput");
const saveSettingsBtn = document.getElementById("saveSettings");
const cancelSettingsBtn = document.getElementById("cancelSettings");

const R = 92;
const C = 2 * Math.PI * R;

const SETTINGS_KEY = "cozyPomodoroSettings";
const CYCLE_KEY = "cozyPomodoroCycle"; // 집중 횟수(동그라미)를 이 기기에 저장하는 키
const SUPABASE_URL = "https://cycviglesmwoozgsofva.supabase.co";
const SUPABASE_PUBLISHABLE_KEY =
  "sb_publishable_iUwiJHboBS2tPiY9mzeHzQ_hS8h8vfI";

/*
  로그인 정보는 sessionStorage에 보관한다. (아래 createClient의 auth.storage)
  → 탭이나 창을 닫으면 로그아웃되고, 같은 탭에서 새로고침하면 로그인이 유지된다.
*/

// 서버 요청이 이 시간 안에 끝나지 않으면 실패로 처리한다.
// (연결은 됐는데 응답이 안 오는 와이파이에서 요청이 오래 매달리는 것을 막는다)
const FETCH_TIMEOUT_MS = 15 * 1000;

function fetchWithTimeout(input, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  // 요청을 보낸 쪽이 따로 취소할 수 있도록 넘긴 signal이 있으면 함께 연결한다.
  if (init.signal) {
    if (init.signal.aborted) controller.abort();
    else {
      init.signal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
    }
  }

  return fetch(input, { ...init, signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
}

const supabaseClient = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY,
  {
    auth: { storage: window.sessionStorage },
    global: { fetch: fetchWithTimeout },
  },
);
let authenticatedUser = null;
let historyLoadToken = 0;
// 전체 기록을 이미 불러온(또는 불러오는 중인) 사용자. 같은 사용자는 다시 불러오지 않는다.
let historyLoadedFor = null; // 오늘 기록을 불러온 사용자
let historyLoadingFor = null;
let fullHistoryFor = null; // 전체 기록까지 불러온 사용자 (분석 화면을 열 때 불러온다)
let fullHistoryLoadingFor = null;

function getLocalDateKey(date = new Date()) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function nextDateKey(key) {
  const [y, m, d] = String(key).split("-").map(Number);

  return getLocalDateKey(new Date(y, m - 1, d + 1));
}

// 날짜별 집중 기록 (Supabase에서 불러온 값, 날짜 키 → 초)
let focusHistoryCache = {};

/*
  elapsed 중에서 자정 이후에 지난 시간.
  누적이 시작된 날짜와 지금 날짜가 같으면 0.
*/
function postMidnightPart(elapsed) {
  if (elapsed <= 0 || focusTotalDate === getLocalDateKey()) {
    return 0;
  }

  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);

  const sinceMidnight = Math.max(
    0,
    Math.floor((Date.now() - midnight.getTime()) / 1000),
  );

  return Math.min(elapsed, sinceMidnight);
}

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY));

    if (
      saved &&
      Number.isFinite(Number(saved.focusMinutes)) &&
      Number(saved.focusMinutes) >= 1 &&
      Number(saved.focusMinutes) <= 180 &&
      Number.isFinite(Number(saved.breakMinutes)) &&
      Number(saved.breakMinutes) >= 1 &&
      Number(saved.breakMinutes) <= 60
    ) {
      // 긴 휴식 설정이 없거나 잘못된 옛 저장값은 기본값(15분)을 쓴다. (0 = 사용 안 함)
      const savedLong = Number(saved.longBreakMinutes);
      const validLong =
        saved.longBreakMinutes !== undefined &&
        saved.longBreakMinutes !== null &&
        Number.isInteger(savedLong) &&
        savedLong >= 0 &&
        savedLong <= 60;

      return {
        focusMinutes: Number(saved.focusMinutes),
        breakMinutes: Number(saved.breakMinutes),
        longBreakMinutes: validLong ? savedLong : 15,
      };
    }
  } catch (e) {
    console.warn("설정 불러오기 실패:", e);
  }

  return {
    focusMinutes: 30,
    breakMinutes: 5,
    longBreakMinutes: 15,
  };
}

let settings = loadSettings();

focusInput.value = settings.focusMinutes;
breakInput.value = settings.breakMinutes;
longBreakInput.value = settings.longBreakMinutes;

let settingsOpen = false;
let settingsWasRunning = false;

let phase = "focus";

/*
  긴 휴식 / 집중 횟수
  - 집중을 FOCUS_ROUNDS번 끝까지 채우면 일반 휴식 대신 긴 휴식이 시작된다.
  - 긴 휴식이 시작되는 순간 집중 횟수(동그라미)는 0으로 초기화된다.
  - 동그라미는 직접 눌러서 칠하거나 지울 수 있다. 종료 버튼은 동그라미를 지우지 않는다.
  - 긴 휴식 시간은 설정 화면에서 정한다. 0분이면 긴 휴식을 쓰지 않고 짧은 휴식만 진행한다.
  - 집중 횟수는 이 기기(localStorage)에 {날짜, 횟수}로 저장한다. 새로고침해도 유지되고,
    날짜가 바뀌면 자동으로 0으로 돌아간다. (서버에는 저장하지 않는다)
*/
const FOCUS_ROUNDS = 4;

// 오늘 저장된 집중 횟수를 불러온다. 다른 날 값이거나 이상한 값이면 0.
function loadFocusCount() {
  try {
    const saved = JSON.parse(localStorage.getItem(CYCLE_KEY));
    const n = Number(saved && saved.count);

    if (
      saved &&
      saved.date === getLocalDateKey() &&
      Number.isInteger(n) &&
      n >= 0 &&
      n < FOCUS_ROUNDS
    ) {
      return n;
    }
  } catch (e) {
    // 저장값이 깨져 있으면 0으로 시작한다.
  }

  return 0;
}

let focusCount = loadFocusCount(); // 지금까지 완료한 집중 횟수 (0 ~ FOCUS_ROUNDS-1)
let focusCountDate = getLocalDateKey(); // focusCount가 어느 날의 값인지
let isLongBreak = false; // 지금 휴식이 긴 휴식인지
let shownFocusCount = -1; // 화면에 그려 둔 횟수 (바뀔 때만 다시 그리기 위함)

let duration = settings.focusMinutes * 60;
let remaining = duration;

let running = false;
let endTime = null;

let timerId = null;
let titleTimeoutId = null;
let hiddenWorker = null;
let hiddenWorkerUrl = null;

/*
  누적 집중시간 계산의 핵심
  (모두 메모리에서만 관리하고, 영구 기록은 Supabase가 맡는다)

  focusTotalDate:
    화면 누적이 시작된 날짜

  totalFocusSeconds:
    이미 확정한 집중 시간. 화면에 보이는 누적 값

  carrySeconds:
    totalFocusSeconds 중 자정 이후(다음 날)에 쌓인 몫
    자정을 넘겨도 `종료`를 누르기 전까지는 totalFocusSeconds가 계속 이어지고,
    `종료`를 누르면 carrySeconds만 남기고 새 날짜로 넘어간다.

  focusSegmentStartRemaining:
    현재 집중 구간이 시작됐을 때의 remaining

  현재 집중 구간에서 실제로 경과한 시간:
    focusSegmentStartRemaining - remaining

  이렇게 하면 일시정지 / 재개 / 다음 단계에서
  같은 시간을 두 번 더하지 않는다.
*/
let focusTotalDate = getLocalDateKey();
let totalFocusSeconds = 0;
let carrySeconds = 0;
let focusSegmentStartRemaining = null;

/*
  날짜 경계 적용 (`종료`를 누를 때만 실행)

  화면 누적에서 어제 몫을 빼고, 자정 이후에 쌓은 몫(carry)만 남긴다.
  자정을 안 넘겼으면 아무것도 하지 않는다.
*/
function applyDayBoundary() {
  const today = getLocalDateKey();

  if (today === focusTotalDate) {
    return false;
  }

  totalFocusSeconds = nextDateKey(focusTotalDate) === today ? carrySeconds : 0;
  carrySeconds = 0;
  focusTotalDate = today;
  focusSegmentStartRemaining = null;

  return true;
}

/*
  종료를 안 눌렀더라도, 날짜가 바뀌었고 자정 이후에 쌓인 집중이
  하나도 없으면(carry가 0) 새 날 00:00으로 자동으로 넘긴다.
  예) 23:00에 집중을 끝내고 탭을 켜 둔 채 다음 날이 된 경우.

  자정 이후 몫이 있으면 건드리지 않는다. (`종료`를 누를 때 정리)
  타이머가 돌아가는 중일 때도 건드리지 않는다.
*/
function rolloverIfIdle() {
  if (running) return;
  if (focusTotalDate === getLocalDateKey()) return;
  if (carrySeconds > 0) return;

  applyDayBoundary();
  render();
}

/*
  현재 집중 구간에서 지금까지 경과한 시간(초)
  타이머 표시(ceil)와 같은 기준으로 계산해서 항상 정수가 된다.
*/
function getFocusSegmentElapsed() {
  if (phase !== "focus" || focusSegmentStartRemaining === null) {
    return 0;
  }

  return Math.max(
    0,
    Math.ceil(focusSegmentStartRemaining) - Math.ceil(remaining),
  );
}

// 화면 표시용: 타이머가 돌아가는 동안에만 진행 중인 시간을 더한다.
function getCurrentFocusElapsed() {
  return running ? getFocusSegmentElapsed() : 0;
}

function commitCurrentFocusTime() {
  const elapsed = getFocusSegmentElapsed();

  if (elapsed > 0) {
    const endMs = Date.now();
    const startMs = endMs - elapsed * 1000;
    persistFocusElapsed(startMs, endMs);
    carrySeconds += postMidnightPart(elapsed);
    totalFocusSeconds += elapsed;
  }

  focusSegmentStartRemaining = null;
  // 정상적으로 확정했으니 "집중 중" 임시 기록은 필요 없다. (위에서 이미 대기열에 적어 둠)
  clearCheckpoint();
}

function changeBackground(list, type) {
  if (list.length === 0) return;

  const current = type === "focus" ? currentFocusBg : currentBreakBg;

  // 직전에 쓴 것을 뺀 나머지 중에서 고른다. (목록이 1개뿐이면 그것을 다시 쓴다)
  const candidates = list
    .map((_, i) => i)
    .filter((i) => list.length === 1 || i !== current);
  const next = candidates[Math.floor(Math.random() * candidates.length)];

  if (type === "focus") currentFocusBg = next;
  else currentBreakBg = next;

  bg.style.opacity = "0";

  clearTimeout(backgroundChangeTimer);

  backgroundChangeTimer = setTimeout(() => {
    // 새 이미지를 미리 받아 보고, 성공했을 때만 바꾼다.
    // 인터넷이 끊겨 실패하면 지금 보이는 배경을 그대로 두고 다시 보이게 한다.
    const loader = new Image();

    loader.onload = () => {
      bg.src = list[next];
      bg.style.opacity = "1";
    };

    loader.onerror = () => {
      bg.style.opacity = "1";
      console.warn("배경 이미지 로딩 실패:", list[next]);
    };

    loader.src = list[next];
  }, 180);
}

function setBackgroundForPhase() {
  if (phase === "focus") {
    changeBackground(FOCUS_BACKGROUNDS, "focus");
  } else {
    changeBackground(BREAK_BACKGROUNDS, "break");
  }
}

setBackgroundForPhase();

function formatTimer(sec) {
  sec = Math.max(0, Math.ceil(sec));

  return (
    String(Math.floor(sec / 60)).padStart(2, "0") +
    ":" +
    String(sec % 60).padStart(2, "0")
  );
}

function formatFocusTotal(sec) {
  sec = Math.max(0, Math.floor(sec));

  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const seconds = sec % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  return `${minutes}m ${seconds}s`;
}

/* 값이 실제로 바뀐 때만 화면을 고친다. */
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function setTabTitle(title) {
  if (document.title !== title) document.title = title;
}

/* 현재 단계 이름 (탭 제목용) */
function phaseLabel() {
  if (phase === "focus") return "집중";
  return isLongBreak ? "긴 휴식" : "휴식";
}

// 집중 횟수를 이 기기에 저장한다.
function saveFocusCount() {
  focusCountDate = getLocalDateKey();

  try {
    localStorage.setItem(
      CYCLE_KEY,
      JSON.stringify({ date: focusCountDate, count: focusCount }),
    );
  } catch (e) {
    // 저장에 실패해도 타이머 동작에는 영향이 없다.
  }
}

// 날짜가 바뀌었으면 집중 횟수를 0으로 돌린다. 바뀌었으면 true.
function resetCycleIfNewDay() {
  if (focusCountDate === getLocalDateKey()) return false;

  focusCount = 0;
  saveFocusCount();
  return true;
}

/* 집중 횟수 동그라미: 완료한 횟수만큼 앞에서부터 채운다. */
function renderCycleDots() {
  resetCycleIfNewDay();

  if (shownFocusCount === focusCount) return;
  shownFocusCount = focusCount;

  const wrap = document.getElementById("cycleDots");
  wrap.querySelectorAll(".cycleDot").forEach((dot, i) => {
    dot.classList.toggle("filled", i < focusCount);
  });
  wrap.setAttribute("aria-label", `집중 ${focusCount}/${FOCUS_ROUNDS} 완료`);
}

/*
  동그라미를 직접 눌러서 고친다.
  - 누른 칸까지 칠한다. (3번째를 누르면 3개)
  - 지금 칠해진 마지막 칸을 다시 누르면 한 칸 줄어든다.
  - 4번째 칸은 집중을 끝까지 채울 때 자동으로 처리되므로 직접 칠할 수 없다.
*/
document.getElementById("cycleDots").addEventListener("click", (event) => {
  const dot = event.target.closest(".cycleDot");
  if (!dot) return;

  const dots = Array.from(document.querySelectorAll("#cycleDots .cycleDot"));
  const n = dots.indexOf(dot) + 1;

  if (n >= FOCUS_ROUNDS) {
    showToast(`${FOCUS_ROUNDS}번째 동그라미는 직접 칠할 수 없어요`);
    return;
  }

  resetCycleIfNewDay();

  focusCount = n === focusCount ? n - 1 : n;
  saveFocusCount();
  render();

  showToast(`집중 횟수 ${focusCount}/${FOCUS_ROUNDS}`);
});

function render() {
  setText(timeEl, formatTimer(remaining));
  renderCycleDots();

  // 자정을 넘어도 현재 집중 구간이 이어지는 동안은 누적 시간을 계속 표시한다.
  const displayedFocusSeconds = totalFocusSeconds + getCurrentFocusElapsed();
  const hasStartedFocus =
    (focusTotalDate === getLocalDateKey() && totalFocusSeconds > 0) ||
    focusSegmentStartRemaining !== null;

  setText(
    totalFocusEl,
    hasStartedFocus ? formatFocusTotal(displayedFocusSeconds) : "--",
  );

  // 돌아가는 중에는 "다음 1초 뒤 위치"를 향해 1초 동안 천천히 움직인다. (갱신은 1초에 한 번)
  const shown = running ? Math.max(0, Math.ceil(remaining) - 1) : remaining;
  const ratio = Math.max(0, Math.min(1, (duration - shown) / duration));

  progress.style.transitionDuration = running ? "1s" : "0.25s";
  progress.style.strokeDasharray = `${C * ratio} ${C}`;

  setTabTitle(`${formatTimer(remaining)} · ${phaseLabel()}`);
}

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add("show");

  clearTimeout(showToast.t);

  showToast.t = setTimeout(() => {
    toast.classList.remove("show");
  }, 2200);
}

const sounds = {
  focusStart: new Audio("sounds/focus-start.wav"),
  focusEnd: new Audio("sounds/focus-end.wav"),
  breakStart: new Audio("sounds/break-start.wav"),
  breakEnd: new Audio("sounds/break-end.wav"),
  pause: new Audio("sounds/pause.wav"),
};

Object.values(sounds).forEach((audio) => {
  audio.preload = "auto";
});

function beep(kind) {
  const audio = sounds[kind];

  try {
    audio.pause();
    audio.currentTime = 0;

    const playPromise = audio.play();

    if (playPromise instanceof Promise) {
      playPromise.catch((error) => {
        console.warn("알림음 재생 실패:", error);
      });
    }
  } catch (error) {
    console.warn("알림음 재생 실패:", error);
  }
}

/*
  마지막 COUNTDOWN_SECONDS(10)초 카운트다운 틱 소리
  - 파일 없이 WebAudio로 짧은 "동" 소리를 만든다.
  - 10, 9, ..., 1초 남았을 때 각각 한 번씩 울린다.
  - 집중/휴식 모두 적용된다.
*/
const COUNTDOWN_SECONDS = 10;
// 카운트다운 소리 크기 (1 = 기본, 숫자를 키울수록 커짐)
const TICK_VOLUME = 3;
let tickCtx = null;
let tickMaster = null;
let lastTickSecond = null;

function unlockTickAudio() {
  try {
    if (!tickCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      tickCtx = new Ctx();

      // 마스터 볼륨 → 컴프레서(찢어짐 방지) → 스피커
      const compressor = tickCtx.createDynamicsCompressor();
      compressor.threshold.value = -10;
      compressor.knee.value = 0;
      compressor.ratio.value = 20;
      compressor.attack.value = 0.001;
      compressor.release.value = 0.06;

      tickMaster = tickCtx.createGain();
      tickMaster.gain.value = TICK_VOLUME;

      tickMaster.connect(compressor);
      compressor.connect(tickCtx.destination);
    }
    if (tickCtx.state !== "running") {
      const p = tickCtx.resume();
      if (p && p.catch) p.catch(() => {});
    }
  } catch (error) {
    console.warn("틱 소리 준비 실패:", error);
  }
}

function playTick() {
  if (!tickCtx || tickCtx.state !== "running") {
    // 브라우저가 컨텍스트를 멈춰 둔 경우 다시 깨워 둔다.
    unlockTickAudio();
    return;
  }

  const t = tickCtx.currentTime;

  // 낮고 둥근 "동" 소리: 음높이 변화 없이 부드럽게 울렸다 사라짐
  const gain = tickCtx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(1, t + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
  gain.connect(tickMaster);

  [
    [587, 1], // 기본음 (레)
    [1174, 0.25], // 한 옥타브 위를 살짝 섞어 따뜻하게
  ].forEach(([freq, level]) => {
    const osc = tickCtx.createOscillator();
    const g = tickCtx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, t);
    g.gain.value = level;
    osc.connect(g);
    g.connect(gain);
    osc.start(t);
    osc.stop(t + 0.47);
  });
}

function countdownTick() {
  if (!running || endTime === null) return;

  const secondsLeft = Math.ceil((endTime - Date.now()) / 1000);

  if (secondsLeft < 1 || secondsLeft > COUNTDOWN_SECONDS) return;
  if (secondsLeft === lastTickSecond) return;

  lastTickSecond = secondsLeft;
  playTick();
}

function stopHiddenTicker() {
  if (hiddenWorker) {
    hiddenWorker.terminate();
    hiddenWorker = null;
  }
  if (hiddenWorkerUrl) {
    URL.revokeObjectURL(hiddenWorkerUrl);
    hiddenWorkerUrl = null;
  }
}

function stopTimers() {
  stopHiddenTicker();
  clearTimeout(timerId);
  clearTimeout(titleTimeoutId);

  timerId = null;
  titleTimeoutId = null;
}

/* 소리·알림 없이 조용히 멈춘다. (설정 창을 열 때, 분석 화면을 열 때 사용) */
function pauseQuietly() {
  if (!running) return;

  remaining = Math.max(0, (endTime - Date.now()) / 1000);

  if (phase === "focus") {
    commitCurrentFocusTime();
  }

  running = false;

  stopTimers();

  endTime = null;

  render();
}

function openSettings() {
  if (settingsOpen) return;

  settingsWasRunning = running;

  pauseQuietly();

  settingsOpen = true;

  focusInput.value = settings.focusMinutes;

  breakInput.value = settings.breakMinutes;

  longBreakInput.value = settings.longBreakMinutes;

  timerContent.classList.add("is-settings");

  settingsContent.classList.add("open");

  settingsContent.setAttribute("aria-hidden", "false");
}

function closeSettings() {
  settingsOpen = false;

  timerContent.classList.remove("is-settings");

  settingsContent.classList.remove("open");

  settingsContent.setAttribute("aria-hidden", "true");
}

function validateSettings() {
  const focusMinutes = Number(focusInput.value);

  const breakMinutes = Number(breakInput.value);

  if (
    !Number.isInteger(focusMinutes) ||
    focusMinutes < 1 ||
    focusMinutes > 180
  ) {
    showToast("집중 시간은 1~180분으로 입력해주세요.");
    return false;
  }

  if (
    !Number.isInteger(breakMinutes) ||
    breakMinutes < 1 ||
    breakMinutes > 60
  ) {
    showToast("짧은 휴식 시간은 1~60분으로 입력해주세요.");
    return false;
  }

  // 빈칸은 Number("") === 0 이라 "사용 안 함"으로 오해되지 않게 따로 막는다.
  const longBreakMinutes = Number(longBreakInput.value);

  if (
    longBreakInput.value.trim() === "" ||
    !Number.isInteger(longBreakMinutes) ||
    longBreakMinutes < 0 ||
    longBreakMinutes > 60
  ) {
    showToast("긴 휴식 시간은 0~60분으로 입력해주세요. (0 = 사용 안 함)");
    return false;
  }

  return true;
}

function saveSettings() {
  if (!validateSettings()) {
    return false;
  }

  const focusMinutes = Number(focusInput.value);

  const breakMinutes = Number(breakInput.value);

  const longBreakMinutes = Number(longBreakInput.value);

  settings = {
    focusMinutes,
    breakMinutes,
    longBreakMinutes,
  };

  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {
    console.warn("설정 저장 실패:", e);
  }

  const wasRunning = settingsWasRunning;

  // 설정 창을 여는 순간 타이머는 이미 멈추고 집중 시간도 확정된 상태다. (openSettings → pauseQuietly)
  settingsWasRunning = false;

  // 설정 변경 전까지 이미 지난 시간
  const elapsed = Math.max(0, duration - remaining);

  // 긴 휴식 중에 긴 휴식을 0분(사용 안 함)으로 바꿨다면 짧은 휴식으로 바꿔 이어간다.
  if (isLongBreak && settings.longBreakMinutes === 0) isLongBreak = false;

  duration =
    phase === "focus"
      ? settings.focusMinutes * 60
      : (isLongBreak ? settings.longBreakMinutes : settings.breakMinutes) * 60;

  // 지난 시간은 유지하고, 새 설정 기준으로 남은 시간 계산 (최소 1초)
  remaining = Math.max(1, duration - elapsed);

  focusSegmentStartRemaining = null;

  setBackgroundForPhase();

  render();

  closeSettings();

  showToast(
    `설정 저장 완료 · 집중 ${focusMinutes}분 / 짧은 휴식 ${breakMinutes}분 / ` +
      `긴 휴식 ${longBreakMinutes > 0 ? `${longBreakMinutes}분` : "사용 안 함"}`,
  );

  // 저장 소리(정지음)는 항상 한 번만 낸다. 이어서 돌릴 때의 시작음은 끈다. (소리 겹침 방지)
  beep("pause");

  if (wasRunning) {
    start({ silent: true, mute: true });
  }

  return true;
}

function cancelSettings() {
  focusInput.value = settings.focusMinutes;

  breakInput.value = settings.breakMinutes;

  longBreakInput.value = settings.longBreakMinutes;

  const shouldResume = settingsWasRunning;

  settingsWasRunning = false;

  closeSettings();

  render();

  // 취소 소리(정지음)는 항상 한 번만 낸다. 이어서 돌릴 때의 시작음·"집중 시작" 안내는 끈다.
  beep("pause");

  if (shouldResume) {
    start({ silent: true, mute: true });
  }

  showToast("설정 변경 취소");
}

timeEl.addEventListener("click", () => {
  if (!settingsOpen) {
    openSettings();
  }
});

timeEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();

    if (!settingsOpen) {
      openSettings();
    }
  }
});

saveSettingsBtn.addEventListener("click", saveSettings);

cancelSettingsBtn.addEventListener("click", cancelSettings);

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;

  // 분석 화면이 열려 있으면 그것부터 닫는다.
  if (currentTab === "analysis") {
    setTab("focus");
  } else if (settingsOpen) {
    cancelSettings();
  }
});

[focusInput, breakInput, longBreakInput].forEach((input) => {
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      saveSettings();
    }
  });
});

function start({ silent = false, mute = false } = {}) {
  if (running) return;
  if (settingsOpen) return;

  running = true;

  /*
  현재 focus 구간의 시작점을
  remaining 기준으로 기록한다.
*/
  if (phase === "focus" && focusSegmentStartRemaining === null) {
    focusSegmentStartRemaining = remaining;
  }

  endTime = Date.now() + remaining * 1000;

  unlockTickAudio();
  lastTickSecond = Math.ceil(remaining);

  if (!mute) beep(phase === "focus" ? "focusStart" : "breakStart");

  if (!silent) {
    showToast(phase === "focus" ? "집중 시작 🍅" : "휴식 시작 ☕");
  }

  render();

  scheduleTick();

  startTitleTimer();
}

/*
  남은 시간을 endTime 기준으로 다시 계산하고,
  0이 됐으면 다음 단계로 넘어간 뒤 true를 돌려준다.
*/
function completeIfTimeUp() {
  remaining = Math.max(0, (endTime - Date.now()) / 1000);

  if (remaining > 0) return false;

  // 시간이 다 돼서 저절로 끝난 경우: 집중 1회 완료로 센다.
  transition(true);
  return true;
}

/* 다음에 숫자가 바뀌는 순간(초 단위 경계)에 맞춰 tick을 예약한다. */
function scheduleTick() {
  clearTimeout(timerId);
  if (!running || endTime === null) return;

  const left = Math.max(0, (endTime - Date.now()) / 1000);
  const nextBoundary = Math.max(0, Math.ceil(left) - 1);
  const delay = Math.max(10, (left - nextBoundary) * 1000 + 5);

  timerId = setTimeout(tick, delay);
}

function tick() {
  if (!running) return;

  if (completeIfTimeUp()) return;

  countdownTick();
  maybeWriteCheckpoint();

  render();

  if (!running) return;

  scheduleTick();
}

function pause() {
  if (!running) return;

  remaining = Math.max(0, (endTime - Date.now()) / 1000);

  if (phase === "focus") {
    commitCurrentFocusTime();
    // 자정을 넘겼다면 정지 시점에 오늘의 누적 시간으로 전환한다.
    applyDayBoundary();
  }

  running = false;

  stopTimers();

  endTime = null;

  beep("pause");

  render();

  showToast("일시정지");
}

/*
  completed: 시간이 다 돼서 저절로 끝난 경우 true.
  `다음 →` 버튼으로 넘길 때는 false라서 집중 횟수에 세지 않는다.
*/
function transition(completed = false) {
  /*
  자동 종료 / 다음 단계 버튼 모두
  여기로 들어온다.

  focus라면 먼저 현재 focus 시간을
  한 번만 확정한다.
*/
  if (running && endTime !== null) {
    remaining = Math.max(0, (endTime - Date.now()) / 1000);
  }

  if (phase === "focus") {
    commitCurrentFocusTime();
    // 다음 단계로 넘어갈 때도 자정 경계를 적용해 오늘의 합계로 전환한다.
    applyDayBoundary();
  }

  running = false;

  stopTimers();

  endTime = null;

  if (phase === "focus") {
    beep("focusEnd");

    phase = "break";

    // 자정을 넘겨 끝난 집중이면 새 날의 첫 번째로 센다.
    resetCycleIfNewDay();

    if (completed) focusCount++;

    if (focusCount >= FOCUS_ROUNDS) {
      // 집중 4번 완료 → 동그라미 초기화.
      // 긴 휴식이 0분(사용 안 함)이면 긴 휴식 대신 짧은 휴식으로 진행한다.
      focusCount = 0;
      isLongBreak = settings.longBreakMinutes > 0;
    } else {
      isLongBreak = false;
    }

    saveFocusCount();

    duration =
      (isLongBreak ? settings.longBreakMinutes : settings.breakMinutes) * 60;

    remaining = duration;

    focusSegmentStartRemaining = null;

    setBackgroundForPhase();

    showToast(
      isLongBreak
        ? `집중 ${FOCUS_ROUNDS}번 완료! ${settings.longBreakMinutes}분 긴 휴식 🌿`
        : `집중 끝! ${settings.breakMinutes}분 휴식 🌿`,
    );
  } else {
    beep("breakEnd");

    phase = "focus";
    isLongBreak = false;

    duration = settings.focusMinutes * 60;

    remaining = duration;

    focusSegmentStartRemaining = null;

    setBackgroundForPhase();

    showToast("휴식 끝! 다시 집중 🍅");
  }

  render();

  // 분석 화면을 보는 중에 휴식이 끝났다면, 집중은 화면을 닫을 때 이어서 시작한다.
  // (분석 화면을 보는 동안 집중 시간이 쌓이지 않게 하기 위함)
  if (currentTab === "analysis") {
    analysisWasRunning = true;
    return;
  }

  // 끝남 소리와 안내 토스트를 이미 냈으므로, 시작 소리·토스트는 생략한다. (소리 겹침 방지)
  start({ silent: true, mute: true });
}

function skip() {
  if (settingsOpen) return;
  transition();
}

/*
  종료: 정지 + 타이머를 집중 처음으로 + 날짜 경계 적용 (집중 횟수 동그라미는 그대로)
*/
function finishSession() {
  if (settingsOpen) return;

  beep("pause");

  if (running && endTime !== null) {
    remaining = Math.max(0, (endTime - Date.now()) / 1000);
  }

  if (running && phase === "focus") {
    commitCurrentFocusTime();
  }

  running = false;
  stopTimers();
  endTime = null;

  focusSegmentStartRemaining = null;

  phase = "focus";
  isLongBreak = false;
  // 집중 횟수(동그라미)는 건드리지 않는다. (실수로 종료를 눌러도 오늘 쌓은 동그라미가 남도록)
  // 동그라미를 지우고 싶으면 동그라미를 직접 눌러서 고친다.
  duration = settings.focusMinutes * 60;
  remaining = duration;

  setBackgroundForPhase();

  applyDayBoundary();
  render();
  showToast("종료");
}

function updateTabTitle() {
  if (!running || endTime === null) {
    return;
  }

  const currentRemaining = Math.max(0, (endTime - Date.now()) / 1000);

  setTabTitle(`${formatTimer(currentRemaining)} · ${phaseLabel()}`);
}

/*
  탭이 숨겨졌을 때(다른 탭을 보고 있을 때)는 브라우저가
  setTimeout을 1초 단위로 몰아서 실행해서 2초씩 건너뛰기도 한다.
  Web Worker의 타이머는 이 제한을 받지 않으므로 0.2초마다
  깨워서 남은 시간을 다시 계산한다. (endTime 기준이라 정확함)
*/
function hiddenTick() {
  if (!running || endTime === null) {
    stopHiddenTicker();
    return;
  }

  if (completeIfTimeUp()) return;

  countdownTick();
  maybeWriteCheckpoint();
  updateTabTitle();
}

function startHiddenTicker() {
  try {
    const blob = new Blob(["setInterval(function(){postMessage(0)},200)"], {
      type: "text/javascript",
    });
    hiddenWorkerUrl = URL.createObjectURL(blob);
    hiddenWorker = new Worker(hiddenWorkerUrl);
    hiddenWorker.onmessage = hiddenTick;
    return;
  } catch (error) {
    stopHiddenTicker();
  }

  // Worker를 못 쓰는 환경용 대체 경로
  const fallback = () => {
    titleTimeoutId = null;
    hiddenTick();
    if (running && endTime !== null && titleTimeoutId === null) {
      titleTimeoutId = setTimeout(fallback, 250);
    }
  };
  titleTimeoutId = setTimeout(fallback, 250);
}

/*
  탭 제목 갱신 담당을 정한다.
  - 화면이 보일 때: tick() → render()가 이미 제목을 고치므로 따로 할 일이 없다.
  - 화면이 숨겨졌을 때: 브라우저가 tick()을 멈추므로 Worker(대체: setTimeout)가 대신 맡는다.
*/
function startTitleTimer() {
  clearTimeout(titleTimeoutId);
  stopHiddenTicker();

  titleTimeoutId = null;

  updateTabTitle();

  if (document.visibilityState !== "visible") {
    startHiddenTicker();
  }
}

/* 탭·페이지가 다시 보일 때 남은 시간을 endTime 기준으로 맞춘다. */
function resyncRunningTimer() {
  if (!running || endTime === null) return;

  if (completeIfTimeUp()) return;

  render();
  scheduleTick();
  startTitleTimer();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    rolloverIfIdle();
    if (resetCycleIfNewDay()) render(); // 밤새 켜 둔 탭이면 동그라미를 비운다
    flushPendingSessions();
  } else {
    // 백그라운드로 가면 브라우저가 타이머를 멈출 수 있으니 지금까지의 집중을 적어 둔다.
    writeCheckpoint();
  }

  resyncRunningTimer();
});

/*
페이지가 잠시 백그라운드로 갔다가
돌아오는 경우에도 타이머는 endTime을
기준으로 계속 정확하게 계산한다.
*/
window.addEventListener("pageshow", (event) => {
  rolloverIfIdle();
  if (resetCycleIfNewDay()) render();
  resyncRunningTimer();

  // 뒤로가기 캐시에서 되살아난 경우: pagehide 때 적은 "닫힘" 표시를 되돌린다.
  if (event.persisted) writeCheckpoint();
});

const startBtn = document.getElementById("start");

startBtn.addEventListener("click", () => {
  // 자정을 넘겨 집중 중이라면, 시작 버튼 클릭 시점에서 구간을 나눠
  // 이후 화면에는 자정 이후의 집중 시간만 누적해 표시한다.
  if (running && phase === "focus" && focusTotalDate !== getLocalDateKey()) {
    remaining = Math.max(0, (endTime - Date.now()) / 1000);
    commitCurrentFocusTime();
    applyDayBoundary();
    focusSegmentStartRemaining = remaining;
    render();
    return;
  }

  rolloverIfIdle();
  start();
});

document.getElementById("pause").addEventListener("click", pause);

document.getElementById("skip").addEventListener("click", skip);

document.getElementById("finish").addEventListener("click", finishSession);

render();

const analysisView = document.getElementById("analysisView");
const monthPane = document.getElementById("monthPane");
const yearPane = document.getElementById("yearPane");
const tabMonthBtn = document.getElementById("tabMonth");
const tabYearBtn = document.getElementById("tabYear");
const yearPrevBtn = document.getElementById("yearPrev");
const yearNextBtn = document.getElementById("yearNext");
const heatScroll = document.getElementById("heatScroll");
const heatBar = document.getElementById("heatBar");
let heatBarTimer = 0;
let heatBarMuteUntil = 0; // 이 시각 전까지는 막대를 띄우지 않는다 (자동 이동용)

let currentTab = "focus"; // focus | analysis
let analysisWasRunning = false; // 분석 화면을 열기 직전에 타이머가 돌고 있었는지
let analysisMode = "year"; // year | month
let calYear = 0;
let calMonth = 0;
let yearView = new Date().getFullYear();

/* 캘린더 날짜칸용 표기: 1h 30m / 45m / 기록 없으면 빈칸 */
function formatShort(sec) {
  sec = Math.floor(Number(sec) || 0);
  if (sec <= 0) return "";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

/* 통계 카드용 표기: 12시간 30분 / 45분 / 기록 없으면 - */
function formatKorean(sec) {
  sec = Math.floor(Number(sec) || 0);
  if (sec <= 0) return "-";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h === 0) return `${m}분`;
  return `${h}시간 ${m}분`;
}

/* 날짜별 기록 + 오늘 진행 중인 집중 시간 */
function getLiveHistory() {
  const today = getLocalDateKey();
  const history = { ...focusHistoryCache };
  if (focusTotalDate === today) {
    history[today] = Math.max(
      0,
      totalFocusSeconds + getCurrentFocusElapsed() - carrySeconds,
    );
  }
  return history;
}

/* ---------- 월간 ---------- */

function renderCalendar() {
  const today = getLocalDateKey();
  const history = getLiveHistory();

  const pad = (n) => String(n).padStart(2, "0");
  const first = new Date(calYear, calMonth, 1).getDay();
  const days = new Date(calYear, calMonth + 1, 0).getDate();
  let html = ["일", "월", "화", "수", "목", "금", "토"]
    .map((d) => `<div class="calDow">${d}</div>`)
    .join("");
  html += "<div></div>".repeat(first);

  let monthTotal = 0;
  let activeDays = 0;
  for (let d = 1; d <= days; d++) {
    const key = `${calYear}-${pad(calMonth + 1)}-${pad(d)}`;
    const sec = Math.floor(Number(history[key]) || 0);
    if (sec > 0) {
      monthTotal += sec;
      activeDays++;
    }
    html += `<div class="calDay${key === today ? " today" : ""}"><b>${d}</b><span>${formatShort(sec)}</span></div>`;
  }

  document.getElementById("calTitle").textContent =
    `${calYear} / ${calMonth + 1}`;
  document.getElementById("calGrid").innerHTML = html;
  document.getElementById("calSummary").innerHTML = `
    <div class="statCard">
      <div class="statLabel">
        <i class="fa-regular fa-clock" aria-hidden="true"></i>
        총 집중
      </div>
      <div class="statValue">${formatKorean(monthTotal)}</div>
    </div>
    <div class="statCard">
      <div class="statLabel">
        <i class="fa-solid fa-chart-column statIcon" aria-hidden="true"></i>
        평균 집중
      </div>
      <div class="statValue">${activeDays > 0 ? formatKorean(monthTotal / activeDays) : "-"}</div>
    </div>`;
}

function moveMonth(delta) {
  const d = new Date(calYear, calMonth + delta, 1);
  calYear = d.getFullYear();
  calMonth = d.getMonth();
  renderCalendar();
}

/* ---------- 연간 (잔디) ---------- */

/* 하루 집중 시간 → 색 단계: 0 없음 / 1 <1h / 2 1~3h / 3 3~5h / 4 5h 이상 */
function heatLevel(sec) {
  if (sec <= 0) return 0;
  if (sec < 3600) return 1;
  if (sec < 3 * 3600) return 2;
  if (sec < 5 * 3600) return 3;
  return 4;
}

function renderYear(keepScroll = false) {
  const today = getLocalDateKey();
  const thisYear = new Date().getFullYear();
  const history = getLiveHistory();

  // 데이터만 갱신될 때(저장 완료·기록 불러오기 완료)는 보고 있던 스크롤 위치를 유지한다.
  const prevScrollLeft = heatScroll.scrollLeft;

  const jan1 = new Date(yearView, 0, 1);
  const lead = jan1.getDay(); // 첫 주에서 1월 1일 앞쪽 빈칸 수
  const daysInYear = Math.round(
    (new Date(yearView + 1, 0, 1) - jan1) / 86400000,
  );
  const weeks = Math.ceil((lead + daysInYear) / 7);

  let cells = "";
  let months = "";
  let total = 0;
  let activeDays = 0;
  let bestRun = 0;
  let run = 0;

  for (let i = 0; i < weeks * 7; i++) {
    const idx = i - lead;
    if (idx < 0 || idx >= daysInYear) {
      cells += '<div class="heatCell empty"></div>';
      continue;
    }
    const date = new Date(yearView, 0, 1 + idx);
    const key = getLocalDateKey(date);
    const sec = Math.floor(Number(history[key]) || 0);

    if (sec > 0) {
      total += sec;
      activeDays++;
      run++;
      if (run > bestRun) bestRun = run;
    } else {
      run = 0;
    }

    if (date.getDate() === 1) {
      months += `<span style="--col:${Math.floor(i / 7)}">${date.getMonth() + 1}월</span>`;
    }

    const tip = sec > 0 ? `${key} · ${formatKorean(sec)}` : key;
    cells += `<div class="heatCell l${heatLevel(sec)}${key === today ? " today" : ""}" title="${tip}"></div>`;
  }

  document.getElementById("heatMonths").innerHTML = months;
  document.getElementById("heatGrid").innerHTML = cells;

  document.getElementById("yearTitle").textContent = `${yearView}년`;

  document.getElementById("statTotal").textContent = formatKorean(total);
  document.getElementById("statDays").textContent = `${activeDays}일`;
  document.getElementById("statStreak").textContent = `${bestRun}일`;
  document.getElementById("statAvg").textContent =
    activeDays > 0 ? formatKorean(total / activeDays) : "-";

  // 기록이 있는 가장 이른 해까지만 이전으로 이동, 올해보다 뒤로는 이동 불가
  const years = Object.keys(history)
    .filter((k) => Number(history[k]) > 0)
    .map((k) => Number(k.slice(0, 4)));
  const minYear = Math.min(thisYear, ...years);
  yearPrevBtn.disabled = yearView <= minYear;
  yearNextBtn.disabled = yearView >= thisYear;

  // 올해는 오늘 칸이 가운데쯤 보이도록 스크롤
  const scroller = heatScroll;
  const todayCell = document.querySelector("#heatGrid .today");
  // 자동 이동으로 생기는 scroll 이벤트에는 막대를 띄우지 않는다. (사용자가 직접 스크롤할 때만 표시)
  heatBarMuteUntil = Date.now() + 250;
  if (keepScroll) {
    scroller.scrollLeft = prevScrollLeft;
  } else {
    scroller.scrollLeft = todayCell
      ? Math.max(0, todayCell.offsetLeft - scroller.clientWidth / 2)
      : 0;
  }
}

function moveYear(delta) {
  const next = yearView + delta;
  if (next > new Date().getFullYear()) return;
  yearView = next;
  renderYear();
}

/* ---------- 분석 화면 / 탭 ---------- */

function renderAnalysis(keepScroll = false) {
  // 분석 화면을 보고 있지 않으면 그릴 필요가 없다. (열 때 setTab에서 다시 그린다)
  if (currentTab !== "analysis") return;

  if (analysisMode === "year") renderYear(keepScroll);
  else renderCalendar();
}

function setAnalysisMode(mode) {
  analysisMode = mode;
  const isYear = mode === "year";
  yearPane.hidden = !isYear;
  monthPane.hidden = isYear;
  tabYearBtn.classList.toggle("active", isYear);
  tabMonthBtn.classList.toggle("active", !isYear);
  tabYearBtn.setAttribute("aria-selected", String(isYear));
  tabMonthBtn.setAttribute("aria-selected", String(!isYear));
  renderAnalysis(); // 화면이 보이는 상태에서 그려야 스크롤 위치가 맞는다
}

const wrapEl = document.querySelector(".wrap");
const authActionsEl = document.getElementById("authActions");

/*
  키보드(Tab)로 조작할 수 있는 영역을 정리한다.
  - 로그인 전: 타이머 전체 잠금
  - 분석 화면이 열려 있는 동안: 뒤에 있는 타이머와 상단 버튼 잠금
*/
function syncInert() {
  const analysisOpen = currentTab === "analysis";
  wrapEl.inert = !authenticatedUser || analysisOpen;
  authActionsEl.inert = analysisOpen;
}

function setTab(tab) {
  const prev = currentTab;
  currentTab = tab;

  analysisView.hidden = tab !== "analysis";
  syncInert();

  /*
    분석 화면을 보는 동안에는 집중 시간이 쌓이지 않도록 집중 타이머만 조용히 멈춘다.
    (휴식 중에는 멈추지 않고 그대로 흘러간다)
    화면을 닫으면(Esc 포함) 이어서 돌린다. 로그아웃돼서 닫힌 경우에는 돌리지 않는다.
  */
  if (tab === "analysis" && prev !== "analysis") {
    if (phase === "focus") {
      analysisWasRunning = running;
      pauseQuietly();
    } else {
      analysisWasRunning = false;
    }
  } else if (tab !== "analysis" && prev === "analysis") {
    const shouldResume = analysisWasRunning;
    analysisWasRunning = false;
    if (shouldResume && authenticatedUser) start({ silent: true, mute: true });
  }

  if (tab === "analysis" && prev !== "analysis") {
    document.getElementById("backToTimer").focus();
  } else if (tab !== "analysis" && prev === "analysis") {
    document.getElementById("openAnalysis").focus();
  }

  // 분석에 들어올 때마다 올해의 연간 화면을 먼저 보여준다
  if (tab === "analysis" && prev !== "analysis") {
    const now = new Date();
    yearView = now.getFullYear();
    calYear = now.getFullYear();
    calMonth = now.getMonth();
    setAnalysisMode("year");
    loadFullHistoryOnce();
  }
}

document.getElementById("openAnalysis").addEventListener("click", () => {
  setTab("analysis");
});
document.getElementById("backToTimer").addEventListener("click", () => {
  setTab("focus");
});

tabYearBtn.addEventListener("click", () => {
  if (analysisMode !== "year") setAnalysisMode("year");
});
tabMonthBtn.addEventListener("click", () => {
  if (analysisMode !== "month") setAnalysisMode("month");
});
/* 잔디 스크롤: 모바일처럼 스크롤할 때만 보이는 얇은 막대 */
function updateHeatBar() {
  if (Date.now() < heatBarMuteUntil) return;

  const { scrollWidth, clientWidth, scrollLeft } = heatScroll;
  if (scrollWidth <= clientWidth + 1) {
    heatBar.style.opacity = "0";
    return;
  }
  const barW = Math.max(28, (clientWidth * clientWidth) / scrollWidth);
  const left =
    (clientWidth - barW) * (scrollLeft / (scrollWidth - clientWidth));
  heatBar.style.width = `${barW}px`;
  heatBar.style.transform = `translateX(${left}px)`;
  heatBar.style.opacity = "1";
  clearTimeout(heatBarTimer);
  heatBarTimer = setTimeout(() => {
    heatBar.style.opacity = "0";
  }, 900);
}

/*
  스크롤 위치가 바뀔 때마다 막대를 갱신한다.
  휠·마우스 드래그·터치 스크롤(아이폰)·키보드 모두 scrollLeft가 바뀌면
  scroll 이벤트가 오므로 이 한 곳으로 충분하다.
*/
heatScroll.addEventListener("scroll", updateHeatBar, { passive: true });

/*
  마우스 휠: 세로 휠을 가로 이동으로 바꾼다.
  - 가로 끝(맨 앞 / 맨 뒤)에 닿았을 때는 바꾸지 않고 페이지 스크롤로 넘긴다.
  - 트랙패드의 가로 스와이프·핀치 확대는 건드리지 않는다.
*/
heatScroll.addEventListener(
  "wheel",
  (e) => {
    if (e.ctrlKey) return;
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;

    const max = heatScroll.scrollWidth - heatScroll.clientWidth;
    if (max <= 0) return;

    const atStart = e.deltaY < 0 && heatScroll.scrollLeft <= 0;
    const atEnd = e.deltaY > 0 && heatScroll.scrollLeft >= max - 1;
    if (atStart || atEnd) return;

    // deltaMode: 0 = 픽셀, 1 = 줄(파이어폭스 등), 2 = 페이지
    const unit =
      e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? heatScroll.clientWidth : 1;
    heatScroll.scrollLeft += e.deltaY * unit;
    e.preventDefault();
  },
  { passive: false },
);

/* 마우스 드래그로 이동 */
let heatDrag = null;
heatScroll.addEventListener("pointerdown", (e) => {
  if (e.pointerType !== "mouse") return;
  heatDrag = { x: e.clientX, left: heatScroll.scrollLeft };
  heatScroll.classList.add("dragging");
  heatScroll.setPointerCapture(e.pointerId);
});
heatScroll.addEventListener("pointermove", (e) => {
  if (heatDrag) {
    heatScroll.scrollLeft = heatDrag.left - (e.clientX - heatDrag.x);
  }
});
function endHeatDrag() {
  heatDrag = null;
  heatScroll.classList.remove("dragging");
}
heatScroll.addEventListener("pointerup", endHeatDrag);
heatScroll.addEventListener("pointercancel", endHeatDrag);

yearPrevBtn.addEventListener("click", () => moveYear(-1));
yearNextBtn.addEventListener("click", () => moveYear(1));
document
  .getElementById("calPrev")
  .addEventListener("click", () => moveMonth(-1));
document
  .getElementById("calNext")
  .addEventListener("click", () => moveMonth(1));

/* ========================================
   집중 기록 저장 (대기열 · 재시도 · 체크포인트)

   - 집중 구간이 끝나면 서버로 보내기 전에 먼저 이 기기(localStorage)에 적어 둔다.
   - 전송에 성공하면 지우고, 실패하면 남겨 두었다가 다시 시도한다.
     (재시도: 로그인 직후 / 인터넷이 다시 연결될 때 / 탭이 다시 보일 때 / 30초마다)
   - 서버에서 전체 기록을 불러오는 건 로그인(페이지를 열 때) 한 번뿐이다.
     저장할 때마다 다시 불러오지 않고, 방금 저장한 기록을 화면 합계에 직접 더한다.
   - 집중하는 동안에는 10초마다 "여기까지 집중했다"를 체크포인트로 적어 둔다.
     탭을 닫거나 앱이 꺼져도 다음에 열 때 그 구간을 대기열로 옮겨 저장한다.
   ======================================== */

const PENDING_KEY = "cozyPomodoroPendingSessions";
const CHECKPOINT_KEY = "cozyPomodoroFocusCheckpoint";
const CHECKPOINT_INTERVAL_MS = 10 * 1000;
const RETRY_INTERVAL_MS = 30 * 1000;
// Supabase(PostgREST)가 한 번에 주는 최대 행 수. API 설정의 Max Rows와 같거나 작게 둔다.
const HISTORY_PAGE_SIZE = 1000;

function readStorageJSON(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch (_) {
    return null;
  }
}

function writeStorageJSON(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch (_) {
    // 저장소를 못 쓰는 환경(사생활 보호 모드 등)에서는 메모리 대기열만 쓴다.
  }
}

// 아직 서버에 올리지 못한 기록 (메모리가 기준, localStorage에 사본)
let pendingSessions = (() => {
  const saved = readStorageJSON(PENDING_KEY);
  if (!Array.isArray(saved)) return [];
  return saved.filter(
    (r) =>
      r &&
      r.user_id &&
      r.started_at &&
      r.ended_at &&
      Number(r.duration_seconds) > 0,
  );
})();

let flushingPending = false;
let flushAgain = false;
let flushNotify = false;
let saveFailing = false;
let lastCheckpointAt = 0;

// 화면 왼쪽 위의 "저장 대기 N건" 표시. 서버에 못 올린 기록이 있을 때만 보인다.
const syncStatusEl = document.getElementById("syncStatus");
const syncStatusText = document.getElementById("syncStatusText");

let syncShowTimer = null;

function pendingCountForUser() {
  if (!authenticatedUser) return 0;
  return pendingSessions.filter((r) => r.user_id === authenticatedUser.id)
    .length;
}

function updateSyncStatus() {
  const count = pendingCountForUser();

  if (count === 0) {
    clearTimeout(syncShowTimer);
    syncShowTimer = null;
    syncStatusEl.hidden = true;
    return;
  }

  setText(syncStatusText, `저장 대기 ${count}건`);

  // 정상적으로 저장될 때는 깜빡이지 않도록, 3초가 지나도 남아 있을 때만 보여 준다.
  if (!syncStatusEl.hidden || syncShowTimer) return;
  syncShowTimer = setTimeout(() => {
    syncShowTimer = null;
    if (pendingCountForUser() > 0) syncStatusEl.hidden = false;
  }, 3000);
}

function savePending() {
  writeStorageJSON(
    PENDING_KEY,
    pendingSessions.length ? pendingSessions : null,
  );
  updateSyncStatus();
}

/* startMs ~ endMs 구간을 자정 기준으로 나눠 DB 행으로 만든다. */
function buildSessionRows(userId, startMs, endMs) {
  const rows = [];
  let cursor = startMs;

  while (cursor < endMs) {
    const midnight = new Date(cursor);
    midnight.setHours(24, 0, 0, 0);

    const segmentEnd = Math.min(endMs, midnight.getTime());
    const seconds = Math.max(0, Math.round((segmentEnd - cursor) / 1000));

    if (seconds > 0) {
      rows.push({
        user_id: userId,
        started_at: new Date(cursor).toISOString(),
        ended_at: new Date(segmentEnd).toISOString(),
        duration_seconds: seconds,
      });
    }

    cursor = segmentEnd;
  }

  return rows;
}

/* ---------- 체크포인트 (집중 중 임시 기록) ---------- */

function writeCheckpoint(closed = false) {
  if (!authenticatedUser || !running || phase !== "focus") return;

  const elapsed = getFocusSegmentElapsed();
  if (elapsed <= 0) return;

  const endMs = Date.now();

  writeStorageJSON(CHECKPOINT_KEY, {
    userId: authenticatedUser.id,
    startMs: endMs - elapsed * 1000,
    endMs,
    closed, // true: 페이지가 닫히는 중에 적은 값
  });
  lastCheckpointAt = endMs;
}

function maybeWriteCheckpoint() {
  if (Date.now() - lastCheckpointAt >= CHECKPOINT_INTERVAL_MS) {
    writeCheckpoint();
  }
}

function clearCheckpoint() {
  writeStorageJSON(CHECKPOINT_KEY, null);
  lastCheckpointAt = 0;
}

/*
  이전에 정상 종료되지 못한 집중 구간을 대기열로 옮긴다.
  다른 탭이 지금 집중 중일 수 있으니, 페이지가 닫히며 적은 값(closed)이거나
  한동안 갱신이 없는 값만 되살린다.
*/
function recoverCheckpoint() {
  const cp = readStorageJSON(CHECKPOINT_KEY);
  if (!cp || !cp.userId) return;

  const stale = Date.now() - Number(cp.endMs) >= CHECKPOINT_INTERVAL_MS * 3;
  if (!cp.closed && !stale) return;

  const rows = buildSessionRows(
    cp.userId,
    Number(cp.startMs),
    Number(cp.endMs),
  );
  if (rows.length) {
    pendingSessions.push(...rows);
    savePending();
  }
  clearCheckpoint();
}

/* ---------- 서버로 보내기 ---------- */

/* true: 저장됨 / false: 실패 / null: 묶음 안에 이미 저장된 기록이 섞여 있음 */
async function insertSessions(rows) {
  try {
    const { error } = await supabaseClient.from("focus_sessions").insert(rows);
    if (!error) return true;

    // 23505(중복): 앞서 보냈는데 응답만 못 받은 기록 → 저장된 것으로 본다.
    // (focus_sessions에 중복 방지용 UNIQUE 인덱스를 만들어 두었을 때 동작)
    if (error.code === "23505") return rows.length === 1 ? true : null;

    console.error("Supabase 집중 기록 저장 실패:", error);
  } catch (error) {
    console.error("Supabase 집중 기록 저장 실패:", error);
  }
  return false;
}

async function flushOnce(userId) {
  const batch = pendingSessions.filter((r) => r.user_id === userId);
  if (!batch.length) return { saved: 0, failed: false };

  let done = [];
  let failed = false;

  const result = await insertSessions(batch);
  if (result === true) {
    done = batch;
  } else if (result === null) {
    // 중복이 섞여 있으면 한 줄씩 보내서 새 기록만 저장한다.
    for (const row of batch) {
      if ((await insertSessions([row])) === true) {
        done.push(row);
      } else {
        failed = true;
        break;
      }
    }
  } else {
    failed = true;
  }

  if (done.length) {
    // 보내는 동안 새로 쌓인 기록은 그대로 남긴다.
    pendingSessions = pendingSessions.filter((r) => !done.includes(r));
    savePending();

    // 서버에서 다시 받아 오지 않고, 방금 저장한 기록을 화면용 합계에 직접 더한다.
    for (const row of done) addSessionToHistory(focusHistoryCache, row);
  }

  return { saved: done.length, failed };
}

/* 전송 중인 저장이 끝날 때까지 기다린다. (최대 maxMs) */
async function waitForFlush(maxMs = 5000) {
  const startedAt = Date.now();
  while (flushingPending && Date.now() - startedAt < maxMs) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/* 대기열을 서버로 올린다. 올린 행 수를 돌려준다. (기록은 다시 불러오지 않고 화면만 갱신한다) */
async function flushPendingSessions({ notify = false } = {}) {
  if (!authenticatedUser) return 0;
  if (notify) flushNotify = true;

  // 이미 전송 중이면 끝난 뒤 한 번 더 확인하도록 표시만 해 둔다.
  if (flushingPending) {
    flushAgain = true;
    return 0;
  }

  const userId = authenticatedUser.id;
  if (!pendingSessions.some((r) => r.user_id === userId)) return 0;

  // 인터넷이 끊겨 있으면 요청을 보내 봐야 실패하므로, 연결될 때까지 기다린다.
  if (!navigator.onLine) {
    saveFailing = true;
    if (notify) {
      showToast("집중 기록 저장 실패 · 연결되면 자동으로 다시 시도해요.");
    }
    return 0;
  }

  flushingPending = true;
  let saved = 0;

  try {
    let failed = false;

    do {
      flushAgain = false;
      const result = await flushOnce(userId);
      saved += result.saved;
      failed = result.failed;
    } while (flushAgain && !failed);

    if (failed) {
      saveFailing = true;
      if (flushNotify) {
        showToast("집중 기록 저장 실패 · 연결되면 자동으로 다시 시도해요.");
      }
    } else if (saved > 0 && saveFailing) {
      saveFailing = false;
      showToast("밀려 있던 집중 기록을 저장했어요.");
    }
  } catch (error) {
    console.error("집중 기록 전송 중 오류:", error);
  } finally {
    flushingPending = false;
    flushNotify = false;
  }

  if (saved > 0) renderAnalysis(true);
  return saved;
}

/* 집중 구간 하나를 기록한다. (대기열에 먼저 적고 → 전송) */
async function persistFocusElapsed(startMs, endMs) {
  if (!authenticatedUser) {
    showToast("로그인이 필요해 집중 기록을 저장하지 못했어요.");
    return;
  }

  const rows = buildSessionRows(authenticatedUser.id, startMs, endMs);
  if (!rows.length) return;

  // 여기까지는 await 전이라 즉시 실행된다. 탭을 바로 닫아도 기기에는 남는다.
  pendingSessions.push(...rows);
  savePending();

  await flushPendingSessions({ notify: true });
}

window.addEventListener("online", () => flushPendingSessions());
// 보낼 기록이 있을 때만 요청이 나가므로, 실패해도 30초마다 같은 간격으로 다시 시도한다.
setInterval(() => flushPendingSessions(), RETRY_INTERVAL_MS);
window.addEventListener("pagehide", () => writeCheckpoint(true));

// 지난번에 끝까지 저장되지 못한 집중 구간이 있으면 대기열로 옮긴다.
recoverCheckpoint();
// 방금 새로고침한 경우(다른 탭이 쓰는 중인지 구분이 안 되는 값)를 위해 한 번 더 확인한다.
setTimeout(recoverCheckpoint, CHECKPOINT_INTERVAL_MS * 3 + 1000);

/* ---------- 불러오기 ---------- */

/* 1000행 제한을 넘기지 않도록 페이지를 나눠 가져온다. sinceIso가 있으면 그 이후에 끝난 기록만. */
async function fetchAllFocusSessions(userId, sinceIso = null) {
  const rows = [];

  for (let from = 0; ; from += HISTORY_PAGE_SIZE) {
    let query = supabaseClient
      .from("focus_sessions")
      .select("started_at,ended_at")
      .eq("user_id", userId);

    if (sinceIso) query = query.gte("ended_at", sinceIso);

    const { data, error } = await query
      .order("started_at", { ascending: true })
      .order("ended_at", { ascending: true })
      .range(from, from + HISTORY_PAGE_SIZE - 1);

    if (error) return { data: null, error };

    rows.push(...data);
    if (data.length < HISTORY_PAGE_SIZE) break;
  }

  return { data: rows, error: null };
}

/* 기록 한 줄을 날짜별 합계(초)에 더한다. 자정을 넘는 기록은 날짜별로 나눈다. */
function addSessionToHistory(history, row) {
  let cursor = new Date(row.started_at).getTime();
  const end = new Date(row.ended_at).getTime();

  while (cursor < end) {
    const startDate = new Date(cursor);
    const midnight = new Date(startDate);
    midnight.setHours(24, 0, 0, 0);

    const segmentEnd = Math.min(end, midnight.getTime());
    const day = getLocalDateKey(startDate);
    const seconds = Math.max(0, Math.round((segmentEnd - cursor) / 1000));

    history[day] = (history[day] || 0) + seconds;
    cursor = segmentEnd;
  }
}

/*
  서버에서 기록을 불러온다. 성공하면 true
  full=false: 오늘 기록만 (로그인할 때. 화면의 오늘 누적 시간용이라 아주 가볍다)
  full=true : 전체 기록 (분석 화면을 처음 열 때)
*/
async function refreshFocusHistory({ full = false } = {}) {
  if (!authenticatedUser) return false;

  const userId = authenticatedUser.id;
  const token = ++historyLoadToken;

  let sinceIso = null;
  if (!full) {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    sinceIso = midnight.toISOString();
  }

  const { data, error } = await fetchAllFocusSessions(userId, sinceIso);

  if (token !== historyLoadToken) return false;

  if (error) {
    console.error("Supabase 집중 기록 불러오기 실패:", error);
    showToast("집중 기록을 불러오지 못했어요.");
    return false;
  }

  const history = {};
  for (const row of data) addSessionToHistory(history, row);

  focusHistoryCache = history;

  // 오늘 누적 시간은 로그인 때(오늘 기록)만 맞춘다. 분석 화면에서 전체를 불러올 때는 건드리지 않는다.
  if (!running && (!full || historyLoadedFor !== userId)) {
    const today = getLocalDateKey();
    // 아직 서버에 못 올린 오늘 기록도 합친다. (올리면 focusHistoryCache에 따로 더해진다)
    const unsent = {};
    for (const row of pendingSessions) {
      if (row.user_id === userId) addSessionToHistory(unsent, row);
    }
    totalFocusSeconds = Math.max(
      0,
      (Number(history[today]) || 0) + (unsent[today] || 0),
    );
    focusTotalDate = today;
    carrySeconds = 0;
  }
  renderAnalysis(true);
  return true;
}

/*
  로그인할 때 오늘 기록만 한 번 불러온다.
  Supabase는 탭에 다시 돌아올 때나 로그인 토큰이 갱신될 때(약 1시간마다)에도
  "로그인 상태" 알림을 다시 보낸다. 그때마다 다시 받아 오지 않도록 막는다.
  (불러오기에 실패했다면 다음 알림 때 다시 시도한다)
*/
async function loadHistoryOnce() {
  if (!authenticatedUser) return;

  const userId = authenticatedUser.id;
  if (
    historyLoadedFor === userId ||
    historyLoadingFor === userId ||
    fullHistoryFor === userId
  ) {
    return;
  }

  historyLoadingFor = userId;
  const ok = await refreshFocusHistory();
  if (historyLoadingFor === userId) historyLoadingFor = null;
  if (ok && authenticatedUser?.id === userId) historyLoadedFor = userId;
}

/* 분석 화면을 열 때 전체 기록을 한 번만 불러온다. */
async function loadFullHistoryOnce() {
  if (!authenticatedUser) return;

  const userId = authenticatedUser.id;
  if (fullHistoryFor === userId || fullHistoryLoadingFor === userId) return;

  fullHistoryLoadingFor = userId;
  const ok = await refreshFocusHistory({ full: true });
  if (fullHistoryLoadingFor === userId) fullHistoryLoadingFor = null;
  if (ok && authenticatedUser?.id === userId) {
    fullHistoryFor = userId;
    historyLoadedFor = userId;
  }
}

function initializeSupabaseAuth() {
  const gate = document.getElementById("authGate");
  const form = document.getElementById("authForm");
  const message = document.getElementById("authMessage");
  const submit = document.getElementById("authSubmit");
  const logout = document.getElementById("authLogout");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    submit.textContent = "로그인 중…";
    message.textContent = "";
    const email = document.getElementById("authEmail").value.trim();
    const password = document.getElementById("authPassword").value;
    let error = null;
    try {
      ({ error } = await supabaseClient.auth.signInWithPassword({
        email,
        password,
      }));
    } catch (e) {
      error = e;
    }
    submit.disabled = false;
    submit.textContent = "로그인";
    if (error) {
      // 연결 문제와 비밀번호 오류를 구분해서 알려 준다.
      const isNetworkError =
        !navigator.onLine ||
        error.name === "AuthRetryableFetchError" ||
        error.status === 0 ||
        error instanceof TypeError;
      message.textContent = isNetworkError
        ? "로그인 실패: 인터넷 연결을 확인하고 다시 시도해 주세요."
        : "로그인 실패: 이메일과 비밀번호를 확인해 주세요.";
      console.error("Supabase 로그인 실패:", error);
    } else {
      message.textContent = "로그인 성공!";
    }
  });

  logout.addEventListener("click", async () => {
    if (running) pause();
    // 저장이 끝난 뒤에 로그아웃해야 방금 집중한 기록이 거절당하지 않는다.
    await waitForFlush();
    await flushPendingSessions();
    await waitForFlush();
    // 이 기기만 로그아웃한다. (기본값은 로그인한 모든 기기를 로그아웃시킨다)
    const { error } = await supabaseClient.auth.signOut({ scope: "local" });
    if (error) {
      console.error("로그아웃 실패:", error);
      showToast("로그아웃에 실패했어요.");
    }
  });

  // 구독하면 INITIAL_SESSION 이벤트로 현재 로그인 상태가 한 번 전달되므로
  // getSession()을 따로 부르지 않는다. (처음 불러오기도 여기서 처리)
  supabaseClient.auth.onAuthStateChange((_event, session) => {
    // Supabase auth callback 안에서 추가 auth 요청을 기다리지 않도록 별도 태스크로 처리한다.
    setTimeout(async () => {
      authenticatedUser = session?.user || null;
      if (authenticatedUser) {
        gate.style.display = "none";
        syncInert();
        authActionsEl.hidden = false;
        message.textContent = "";
        updateSyncStatus();

        // 오늘 기록을 불러오는 동안은 시작 버튼을 잠근다.
        // (그 사이에 시작하면 오늘 누적 시간이 서버 기록과 맞지 않게 된다)
        const uid = authenticatedUser.id;
        if (historyLoadedFor !== uid && fullHistoryFor !== uid) {
          startBtn.disabled = true;
        }

        try {
          // 밀려 있던 기록을 먼저 올린 뒤, 전체 기록은 사용자당 한 번만 불러온다.
          await flushPendingSessions();
          await loadHistoryOnce();
        } finally {
          // 다른 알림이 아직 불러오는 중이면 계속 잠가 둔다. (불러오기에 실패해도 시작은 할 수 있다)
          startBtn.disabled = historyLoadingFor !== null;
        }
        render();
      } else {
        historyLoadToken++;
        historyLoadedFor = null;
        historyLoadingFor = null;
        fullHistoryFor = null;
        fullHistoryLoadingFor = null;
        setTab("focus");
        focusHistoryCache = {};

        // 로그아웃한 사람의 누적 시간이 화면에 남지 않도록 비운다. (타이머가 도는 중이면 건드리지 않는다)
        if (!running) {
          totalFocusSeconds = 0;
          carrySeconds = 0;
          focusTotalDate = getLocalDateKey();
          focusSegmentStartRemaining = null;
          render();
        }

        startBtn.disabled = false;
        updateSyncStatus();
        gate.style.display = "flex";
        syncInert(); // 로그인 전에는 탭키로도 타이머를 조작할 수 없게 한다
        authActionsEl.hidden = true;

        // 로그아웃 후 입력값 초기화
        form.reset();
        message.textContent = "";

        renderAnalysis();
      }
    }, 0);
  });
}

initializeSupabaseAuth();
