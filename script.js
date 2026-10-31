/*
  supabase-js(CDN)를 불러오지 못하면 아래 코드가 전부 멈춰서 화면이 아무 반응도 없게 된다.
  (인터넷 문제, 광고 차단기, SRI 해시 불일치 등) 그래서 이유를 알려 주고 멈춘다.
*/
if (!window.supabase) {
  document.getElementById("authGate").style.display = "flex";
  document.getElementById("authMessage").textContent =
    "필수 라이브러리(Supabase)를 불러오지 못했어요.\n\n인터넷 연결을 확인하고 새로고침해 주세요.";
  document.getElementById("authSubmit").disabled = true;
  throw new Error("supabase-js 로드 실패");
}

const FOCUS_BACKGROUNDS = [
  "backgrounds/bg1.jpg",
  "backgrounds/bg2.jpg",
  "backgrounds/bg3.jpg",
  "backgrounds/bg4.jpg",
  "backgrounds/bg5.jpg",
];

const BREAK_BACKGROUNDS = ["backgrounds/break.jpg"];

let currentFocusBg = -1;
let currentBreakBg = -1;
let backgroundChangeTimer = null;
let backgroundToken = 0; // 배경을 바꿀 때마다 올려서, 늦게 도착한 옛 이미지는 버린다

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
const CYCLE_KEY = "cozyPomodoroCycle"; // 집중 횟수를 이 탭에 저장하는 키 (sessionStorage)
const SUPABASE_URL = "https://cycviglesmwoozgsofva.supabase.co";
const SUPABASE_PUBLISHABLE_KEY =
  "sb_publishable_iUwiJHboBS2tPiY9mzeHzQ_hS8h8vfI";

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

/*
  로그인 정보는 sessionStorage에 보관한다. (아래 auth.storage)
  → 탭이나 창을 닫으면 로그아웃되고, 같은 탭에서 새로고침하면 로그인이 유지된다.
*/
const supabaseClient = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY,
  {
    auth: { storage: window.sessionStorage },
    global: { fetch: fetchWithTimeout },
  },
);
let authenticatedUser = null;
let lastKnownUserId = null; // 로그인이 풀린 뒤에 끝난 집중 기록도 이 사용자 몫으로 대기열에 남긴다
let historyLoadToken = 0; // 기록을 불러올 때마다 올려서, 늦게 도착한 옛 응답은 버린다
// 같은 사용자의 기록은 다시 불러오지 않도록, 불러온(또는 불러오는 중인) 사용자를 기억해 둔다.
let historyLoadedFor = null; // 오늘 기록을 불러온 사용자
let historyLoadingFor = null; // 오늘 기록을 불러오는 중인 사용자
let fullHistoryFor = null; // 전체 기록까지 불러온 사용자 (분석 화면을 처음 열 때 불러온다)
let fullHistoryLoadingFor = null; // 전체 기록을 불러오는 중인 사용자

function getLocalDateKey(date = new Date()) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

// 날짜별 집중 기록 (Supabase에서 불러온 값, 날짜 키 → 초)
let focusHistoryCache = {};

/*
  저장된 값(이 기기 또는 서버)이 올바른 설정인지 검사해서 설정 객체로 돌려준다. 올바르지 않으면 null.
  긴 휴식 값이 없거나 잘못된 옛 저장값은 기본값(15분)을 쓴다. (0 = 사용 안 함)
*/
function parseSettings(saved) {
  if (!saved) return null;

  const focusMinutes = Number(saved.focusMinutes);
  const breakMinutes = Number(saved.breakMinutes);

  if (
    !Number.isInteger(focusMinutes) ||
    focusMinutes < 1 ||
    focusMinutes > 180 ||
    !Number.isInteger(breakMinutes) ||
    breakMinutes < 1 ||
    breakMinutes > 60
  ) {
    return null;
  }

  const savedLong = Number(saved.longBreakMinutes);
  const validLong =
    saved.longBreakMinutes != null &&
    Number.isInteger(savedLong) &&
    savedLong >= 0 &&
    savedLong <= 60;

  return {
    focusMinutes,
    breakMinutes,
    longBreakMinutes: validLong ? savedLong : 15,
  };
}

function loadSettings() {
  try {
    const saved = parseSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY)));
    if (saved) return saved;
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

let settingsOpen = false;
let settingsWasRunning = false;

let phase = "focus";

let currentTab = "focus"; // focus | analysis
let analysisWasRunning = false; // 분석 화면을 열기 직전에 타이머가 돌고 있었는지

/*
  긴 휴식 / 집중 횟수
  - 집중을 FOCUS_ROUNDS번 끝까지 채우면 일반 휴식 대신 긴 휴식이 시작된다.
  - 긴 휴식이 시작되는 순간 집중 횟수는 0으로 초기화된다.
  - 왼쪽 위 "0 / 4"를 누를 때마다 횟수가 0 → 1 → 2 → 3 → 0 으로 바뀐다. (직접 고칠 때 쓴다)
  - 긴 휴식 시간은 설정 화면에서 정한다. 0분이면 긴 휴식을 쓰지 않고 짧은 휴식만 진행한다.
  - 집중 횟수는 이 탭(sessionStorage)에 {날짜, 횟수}로 저장한다. 새로고침해도 유지되지만,
    탭이나 창을 닫으면 자동으로 0으로 돌아간다. 날짜가 바뀌어도 0으로 돌아간다.
    (서버에는 저장하지 않는다)
*/
const FOCUS_ROUNDS = 4;

// 이 탭에 저장된 오늘 집중 횟수를 불러온다. 다른 날 값이거나 이상한 값이면 0.
function loadFocusCount() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(CYCLE_KEY));
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

/* 지금 단계(집중 / 짧은 휴식 / 긴 휴식)의 전체 길이(초) */
function getPhaseSeconds() {
  if (phase === "focus") return settings.focusMinutes * 60;
  return (isLongBreak ? settings.longBreakMinutes : settings.breakMinutes) * 60;
}

/*
  누적 집중시간 계산의 핵심
  (모두 메모리에서만 관리하고, 영구 기록은 Supabase가 맡는다)

  하루 기준: 집중 구간(시작/재개 ~ 정지/다음/종료)은 "시작한 날짜"의 집중이다.
  자정을 넘겨 끝나도 구간 전체가 시작한 날짜에 기록된다.
  (예: 23:40에 시작해 00:10에 끝나면 30분 전부 전날)

  focusTotalDate:
    화면 누적이 속한 날짜. 집중 구간을 시작할 때 오늘로 맞추고,
    자정을 넘겨도 그 구간이 끝날 때까지 바뀌지 않는다.

  totalFocusSeconds:
    이미 확정한 집중 시간. 화면에 보이는 누적 값 (focusTotalDate의 하루치)

  lastFocusCommitDate:
    마지막으로 집중 시간을 확정한 날짜.
    자정을 넘겨 끝난 직후에는 어제 누적을 그대로 보여 주고,
    새 날의 집중을 시작하거나 `종료`를 누를 때 새 날로 넘어간다.

  focusSegmentStartRemaining:
    현재 집중 구간이 시작됐을 때의 remaining

  현재 집중 구간에서 실제로 경과한 시간:
    focusSegmentStartRemaining - remaining

  이렇게 하면 일시정지 / 재개 / 다음 단계에서
  같은 시간을 두 번 더하지 않는다.
*/
let focusTotalDate = getLocalDateKey();
let totalFocusSeconds = 0;
let lastFocusCommitDate = null;
let focusSegmentStartRemaining = null;

/*
  화면 누적을 오늘 날짜로 넘긴다. (새 날의 집중을 시작할 때, `종료`를 누를 때)
  이미 오늘이면 아무것도 하지 않는다.
*/
function applyDayBoundary() {
  const today = getLocalDateKey();

  if (today === focusTotalDate) {
    return false;
  }

  totalFocusSeconds = Number(focusHistoryCache[today]) || 0;
  focusTotalDate = today;
  focusSegmentStartRemaining = null;

  return true;
}

// 화면 누적의 날짜를 그대로 보여 줘도 되는지.
// 오늘이거나, 자정을 넘겨 끝난 집중이 있어서 시작·종료를 기다리는 중이면 true.
function isTotalDateCurrent() {
  const today = getLocalDateKey();
  return focusTotalDate === today || lastFocusCommitDate === today;
}

/*
  날짜가 바뀌었는데 자정 이후에 끝난 집중이 없으면(isTotalDateCurrent가 false),
  종료를 안 눌러도 새 날 00:00으로 자동으로 넘긴다.
  예) 23:00에 집중을 끝내고 탭을 켜 둔 채 다음 날이 된 경우.

  자정 이후에 끝난 집중이 있으면 건드리지 않는다. (새 집중을 시작하거나 `종료`를 누를 때 넘어간다)
  타이머가 돌아가는 중일 때도 건드리지 않는다.
*/
function rolloverIfIdle() {
  if (running || isTotalDateCurrent()) return;

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
    totalFocusSeconds += elapsed;
    lastFocusCommitDate = getLocalDateKey(new Date(endMs));
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

  const token = ++backgroundToken;

  bg.style.opacity = "0";

  clearTimeout(backgroundChangeTimer);

  backgroundChangeTimer = setTimeout(() => {
    // 새 이미지를 미리 받아 보고, 성공했을 때만 바꾼다.
    // 인터넷이 끊겨 실패하면 지금 보이는 배경을 그대로 두고 다시 보이게 한다.
    const loader = new Image();

    loader.onload = () => {
      if (token !== backgroundToken) return; // 그 사이 더 새 배경 요청이 있었다
      bg.src = list[next];
      bg.style.opacity = "1";
    };

    loader.onerror = () => {
      if (token !== backgroundToken) return;
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
    return `${hours}시간 ${minutes}분 ${seconds}초`;
  }

  return `${minutes}분 ${seconds}초`;
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

// 집중 횟수를 이 탭에 저장한다. (탭·창을 닫으면 함께 사라진다)
function saveFocusCount() {
  focusCountDate = getLocalDateKey();

  try {
    sessionStorage.setItem(
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

/* 집중 횟수 표시: 완료한 횟수를 "2 / 4" 형태로 보여 준다. */
function renderCycleCount() {
  resetCycleIfNewDay();

  if (shownFocusCount === focusCount) return;
  shownFocusCount = focusCount;

  const btn = document.getElementById("cycleCount");
  btn.textContent = `${focusCount} / ${FOCUS_ROUNDS}`;
  btn.setAttribute(
    "aria-label",
    `집중 ${focusCount}/${FOCUS_ROUNDS} 완료. 누르면 횟수가 바뀌어요`,
  );
}

/*
  "0 / 4"를 눌러서 횟수를 직접 고친다.
  - 누를 때마다 0 → 1 → 2 → 3 → 0 으로 바뀐다.
  - 4는 집중을 끝까지 채울 때 자동으로 처리(긴 휴식 시작 + 0으로 초기화)되므로 직접 만들 수 없다.
*/
document.getElementById("cycleCount").addEventListener("click", () => {
  resetCycleIfNewDay();

  focusCount = (focusCount + 1) % FOCUS_ROUNDS;
  saveFocusCount();
  render();

  showToast(`집중 횟수 ${focusCount}/${FOCUS_ROUNDS}`);
});

function render() {
  setText(timeEl, formatTimer(remaining));
  renderCycleCount();

  // 자정을 넘어도 현재 집중 구간이 이어지는 동안은 시작한 날의 누적 시간을 계속 표시한다.
  const displayedFocusSeconds = totalFocusSeconds + getCurrentFocusElapsed();
  const hasStartedFocus =
    (isTotalDateCurrent() && totalFocusSeconds > 0) ||
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

/*
  알림음
  - 소리 파일을 WebAudio 버퍼로 미리 불러 두고, 사용자 동작(클릭·터치·키 입력)으로 이미 깨워 둔
    AudioContext(카운트다운 틱과 같은 것)로 재생한다.
    iOS Safari는 사용자 동작 없이 new Audio().play()를 막는 경우가 있어서,
    타이머가 저절로 끝날 때 나는 소리(집중 끝·휴식 끝)가 안 날 수 있기 때문이다.
  - 버퍼가 아직 없거나 AudioContext가 멈춰 있으면 예전 방식(<audio>)으로 대신 재생한다.
*/
const SOUND_FILES = {
  focusStart: "sounds/focus-start.wav",
  focusEnd: "sounds/focus-end.wav",
  breakStart: "sounds/break-start.wav",
  breakEnd: "sounds/break-end.wav",
  pause: "sounds/pause.wav",
};

/*
  아이폰·아이패드(사파리): 이 앱의 소리를 다른 앱(유튜브·넷플릭스 등)과 섞어서 내도록 미리 알려 둔다.
  이걸 안 하면 버튼을 누를 때마다 소리 장치를 깨우면서 다른 앱의 소리를 멈추게 한다.
  - "ambient": 다른 앱 소리와 같이 낸다. 대신 아이폰 옆면의 무음 스위치를 켜 두면 알림음도 나지 않는다.
  - 지원하지 않는 브라우저(크롬 등)에서는 아무 일도 하지 않는다.
*/
function useAmbientAudioSession() {
  try {
    if (navigator.audioSession) navigator.audioSession.type = "ambient";
  } catch (error) {
    console.warn("오디오 세션 설정 실패:", error);
  }
}

useAmbientAudioSession();

// 대체 재생용 <audio>
const sounds = {};
Object.entries(SOUND_FILES).forEach(([kind, url]) => {
  const audio = new Audio(url);
  audio.preload = "auto";
  sounds[kind] = audio;
});

const soundBuffers = {}; // 디코딩이 끝난 소리 (kind → AudioBuffer)
let soundBuffersRequested = false;

function loadSoundBuffers() {
  if (!tickCtx || soundBuffersRequested) return;
  soundBuffersRequested = true;

  Object.entries(SOUND_FILES).forEach(async ([kind, url]) => {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      soundBuffers[kind] = await tickCtx.decodeAudioData(
        await res.arrayBuffer(),
      );
    } catch (error) {
      console.warn(
        "알림음 미리 불러오기 실패 (<audio>로 대신 재생):",
        kind,
        error,
      );
    }
  });
}

function playWithAudioElement(kind) {
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

function beep(kind) {
  unlockTickAudio(); // 사용자 동작 안에서 불린 경우 오디오를 깨워 둔다
  loadSoundBuffers();

  const buffer = soundBuffers[kind];

  if (buffer && tickCtx && tickCtx.state === "running") {
    try {
      const source = tickCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(tickCtx.destination);
      source.start();
      return;
    } catch (error) {
      console.warn("알림음 재생 실패 (<audio>로 대신 재생):", error);
    }
  }

  playWithAudioElement(kind);
}

// 첫 클릭·터치·키 입력 때 오디오를 깨우고 소리를 미리 불러 둔다. (이미 깨어 있으면 아무 일도 안 한다)
function primeAudio() {
  unlockTickAudio();
  loadSoundBuffers();
}

["click", "touchend", "keydown"].forEach((type) => {
  document.addEventListener(type, primeAudio, true);
});

/*
  마지막 COUNTDOWN_SECONDS(10)초 카운트다운 틱 소리
  - 파일 없이 WebAudio로 짧은 "동" 소리를 만든다.
  - 10, 9, ..., 1초 남았을 때 각각 한 번씩 울린다.
    (시작·재개한 순간의 초는 건너뛴다. 예: 8초 남기고 재개하면 8초 소리는 내지 않는다)
  - 집중/휴식 모두 적용된다.
*/
const COUNTDOWN_SECONDS = 10;
// 카운트다운 소리 크기 (1 = 기본, 숫자를 키울수록 커짐)
const TICK_VOLUME = 3;
let tickCtx = null;
let tickMaster = null;
let lastTickSecond = null;
let keepAliveOsc = null;
const KEEP_ALIVE_SECONDS = 13;

// 타이머가 도는 동안 안 들리는 소리를 흘려서 오디오 장치가 잠들지 않게 한다.
function startAudioKeepAlive() {
  if (!tickCtx || keepAliveOsc) return;
  try {
    const osc = tickCtx.createOscillator();
    const g = tickCtx.createGain();
    osc.frequency.value = 100;
    g.gain.value = 0.0001;
    osc.connect(g);
    g.connect(tickCtx.destination);
    osc.start();
    keepAliveOsc = osc;
  } catch (error) {
    console.warn("오디오 유지 실패:", error);
  }
}

function stopAudioKeepAlive() {
  if (!keepAliveOsc) return;
  try {
    keepAliveOsc.stop();
  } catch (_) {
    // 이미 멈춘 경우라 무시한다.
  }
  keepAliveOsc = null;
}

function unlockTickAudio() {
  try {
    if (!tickCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      useAmbientAudioSession(); // 소리 장치를 만들기 전에 한 번 더 확인해 둔다
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

  // 카운트다운 소리 직전(KEEP_ALIVE_SECONDS초 전)부터 오디오 장치를 깨워 둔다.
  if (secondsLeft >= 1 && secondsLeft <= KEEP_ALIVE_SECONDS)
    startAudioKeepAlive();

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
  stopAudioKeepAlive();
  stopHiddenTicker();
  clearTimeout(timerId);
  clearTimeout(titleTimeoutId);

  timerId = null;
  titleTimeoutId = null;
}

/* 소리·알림 없이 조용히 멈춘다. (설정 창·분석 화면을 열 때, 다른 탭에서 시작했을 때, 로그인이 풀렸을 때, pause()에서 사용) */
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

  settingsContent.inert = false;
}

function closeSettings() {
  settingsOpen = false;

  timerContent.classList.remove("is-settings");

  settingsContent.classList.remove("open");

  settingsContent.inert = true;
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

  // 다른 기기와 같은 설정을 쓰도록 서버에도 저장한다. (실패해도 이 기기에는 이미 저장됨)
  pushSettingsToServer();

  const wasRunning = settingsWasRunning;

  // 설정 창을 여는 순간 타이머는 이미 멈추고 집중 시간도 확정된 상태다. (openSettings → pauseQuietly)
  settingsWasRunning = false;

  // 설정 변경 전까지 이미 지난 시간
  const elapsed = Math.max(0, duration - remaining);

  // 긴 휴식 중에 긴 휴식을 0분(사용 안 함)으로 바꿨다면 짧은 휴식으로 바꿔 이어간다.
  if (isLongBreak && settings.longBreakMinutes === 0) isLongBreak = false;

  duration = getPhaseSeconds();

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
  새 집중 구간은 시작하는 날의 집중이므로, 화면 누적을 오늘로 먼저 맞춘다.
*/
  if (phase === "focus" && focusSegmentStartRemaining === null) {
    applyDayBoundary();
    focusSegmentStartRemaining = remaining;
  }

  endTime = Date.now() + remaining * 1000;

  announceTimerStart();

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

  pauseQuietly(); // 멈추고, 집중 시간을 확정하고, 화면을 고친다

  beep("pause");

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
      // 집중 4번 완료 → 집중 횟수 초기화.
      // 긴 휴식이 0분(사용 안 함)이면 긴 휴식 대신 짧은 휴식으로 진행한다.
      focusCount = 0;
      isLongBreak = settings.longBreakMinutes > 0;
    } else {
      isLongBreak = false;
    }

    saveFocusCount();

    duration = getPhaseSeconds();

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

    duration = getPhaseSeconds();

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
  종료: 정지 + 타이머를 집중 처음으로 + 집중 횟수 초기화 + 화면 누적을 오늘 날짜로 넘김
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
  // 종료하면 집중 횟수도 0으로 초기화한다.
  // 실수로 종료했다면 "0 / 4"를 눌러서 다시 맞출 수 있다.
  focusCount = 0;
  saveFocusCount();
  duration = getPhaseSeconds();
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
  } catch {
    // Worker를 만들지 못했다. 만들다 남은 것을 정리하고 아래 대체 경로를 쓴다.
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
  숨겨진 탭을 돌보는 담당을 정한다. (이름은 startTitleTimer지만 제목만 고치는 게 아니다)
  - 화면이 보일 때: tick()이 시간 확인·소리·제목을 모두 처리하므로 따로 할 일이 없다.
  - 화면이 숨겨졌을 때: 브라우저가 tick()을 느리게(1초 이상) 돌리므로, Worker(대체: setTimeout)가
    시간 끝 확인·카운트다운 소리·체크포인트·탭 제목 갱신을 대신 맡는다.
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
    if (resetCycleIfNewDay()) render(); // 밤새 켜 둔 탭이면 집중 횟수를 0으로 돌린다
    flushPendingSessions({ force: true });
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

/*
  여러 탭 동시 실행 방지
  - 한 탭에서 타이머를 시작하면 같은 계정으로 돌고 있던 다른 탭은 조용히 멈춘다. (마지막에 시작한 탭이 이긴다)
  - 멈추는 탭은 그때까지의 집중을 정상적으로 확정하므로, 같은 시간이 두 번 집계되지 않는다.
  - BroadcastChannel을 지원하지 않는 오래된 브라우저에서는 아무 일도 하지 않는다.
*/
const tabId = Math.random().toString(36).slice(2);
let tabChannel = null;

try {
  if ("BroadcastChannel" in window) {
    tabChannel = new BroadcastChannel("cozyPomodoroTimer");
  }
} catch (_) {
  tabChannel = null;
}

function announceTimerStart() {
  try {
    tabChannel?.postMessage({
      type: "timer-started",
      tabId,
      userId: authenticatedUser?.id || null,
    });
  } catch (_) {
    // 알리지 못해도 이 탭의 동작에는 영향이 없다.
  }
}

if (tabChannel) {
  tabChannel.onmessage = (event) => {
    const msg = event.data;
    if (!msg || msg.type !== "timer-started" || msg.tabId === tabId) return;
    if (!authenticatedUser || msg.userId !== authenticatedUser.id) return;

    // 설정 창·분석 화면을 닫을 때 이어서 돌리려던 예약도 취소한다.
    settingsWasRunning = false;
    analysisWasRunning = false;

    if (running) {
      pauseQuietly();
      showToast("다른 탭에서 타이머를 시작해서 이 탭은 멈췄어요.");
    }
  };
}

const startBtn = document.getElementById("start");

startBtn.addEventListener("click", () => {
  rolloverIfIdle();
  start();
});

document.getElementById("pause").addEventListener("click", pause);

document.getElementById("skip").addEventListener("click", skip);

document.getElementById("finish").addEventListener("click", finishSession);

render();

const analysisView = document.getElementById("analysisView");
const weekPane = document.getElementById("weekPane");
const monthPane = document.getElementById("monthPane");
const yearPane = document.getElementById("yearPane");
const tabWeekBtn = document.getElementById("tabWeek");
const tabMonthBtn = document.getElementById("tabMonth");
const tabYearBtn = document.getElementById("tabYear");
const weekPrevBtn = document.getElementById("weekPrev");
const weekNextBtn = document.getElementById("weekNext");
const yearPrevBtn = document.getElementById("yearPrev");
const yearNextBtn = document.getElementById("yearNext");
const heatScroll = document.getElementById("heatScroll");
const heatBar = document.getElementById("heatBar");
let heatBarTimer = 0;
let heatBarMuteUntil = 0; // 이 시각 전까지는 막대를 띄우지 않는다 (자동 이동용)

let analysisMode = "year"; // week | month | year
let calYear = 0;
let calMonth = 0;
let weekStart = null; // 주간 화면에서 보고 있는 주의 일요일 (Date)
let yearView = new Date().getFullYear();

/* 주간 막대 위·월간 날짜 칸 공통 표기: 2시간 2분 / 45분 / 2시간. 1분 미만은 빈칸.
   시간과 분을 각각 .tu 로 감싸서, 아이폰 세로에서는 두 줄로 나눈다. (style.css) */
function formatShort(sec) {
  sec = Math.floor(Number(sec) || 0);
  if (sec < 60) return "";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const parts = [];
  if (h > 0) parts.push(`<span class="tu">${h}시간</span>`);
  if (m > 0) parts.push(`<span class="tu">${m}분</span>`);
  return parts.join(" ");
}

/* 통계용 표기: 12시간 30분 / 12시간 (정각이면 0분 생략) / 45분 / 기록 없으면 0분 */
function formatKorean(sec) {
  sec = Math.floor(Number(sec) || 0);
  if (sec <= 0) return "0분";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h === 0) return `${m}분`;
  if (m === 0) return `${h}시간`;
  return `${h}시간 ${m}분`;
}

/* 요약 문장 안에서 시간·날짜 숫자만 흰색으로 강조한다. (style.css의 .statHeroSub .hl) */
function hl(text) {
  return `<span class="hl">${text}</span>`;
}

/* 분석 화면 맨 위 요약 (주간·월간·연간 공통)
   lead: 기간 문구("이번 달은") / total: 총 집중 시간(초) / activeDays: 집중한 날 수
   loading: 전체 기록을 불러오는 중이면 true (숫자 대신 "--")
   notes: 평균 줄 위에 놓을 줄들 (이전 기간 비교 문장). 총 시간 바로 아래에 와야 비교 대상이 총 시간임이 읽힌다. */
function renderStatHero(
  el,
  { lead, total, activeDays, loading, notes = [], subLines = 2 },
) {
  const hasRecord = !loading && total > 0;
  let main = "집중 기록이 없어요";
  let sub = "";
  if (loading) {
    main = "<span>총</span> -- <span>집중했어요</span>";
    sub = `${hl("--일")} 동안, 하루 평균 ${hl("--")} 집중했어요`;
  } else if (hasRecord) {
    main = `<span>총</span> ${formatKorean(total)} <span>집중했어요</span>`;
    sub = `${hl(`${activeDays}일`)} 동안, 하루 평균 ${hl(formatKorean(total / activeDays))} 집중했어요`;
  }
  // 비교 줄이 먼저, 평균 줄이 마지막. 비교 줄이 없으면(이전 기록 없음) 빈 문자열이라 걸러진다.
  const lines = [...(loading ? [] : notes), sub].filter(Boolean);
  // 줄 수가 달라도 아래 달력·그래프 위치가 움직이지 않도록 빈 줄로 채운다. (빈 줄은 맨 아래에 남는다)
  while (lines.length < subLines) lines.push("&nbsp;");
  el.innerHTML =
    `<div class="statHeroLead">${lead}</div>` +
    `<div class="statHeroMain">${main}</div>` +
    lines.map((t) => `<div class="statHeroSub">${t}</div>`).join("");
}

/* 비교 문장용 시간 표기: 1시간 20분 / 12시간 / 45분 (0인 단위는 생략) */
function formatDiff(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return [h > 0 && `${h}시간`, m > 0 && `${m}분`].filter(Boolean).join(" ");
}

/* 이전 기간 이름. last: 보고 있는 기간이 진행 중일 때("지난주보다") / ended: 이미 끝난 기간을 볼 때("전주보다") */
const COMPARE_NAMES = {
  week: { last: "지난주", ended: "전주" },
  month: { last: "지난달", ended: "전월" },
  year: { last: "지난해", ended: "전년" },
};

/* 이전 기간과 비교하는 문장. 예) "▲ 지난주보다 1시간 20분 늘었어요" / "지난주와 집중 시간이 같아요"
   unit: week | month | year
   ongoing: 보고 있는 기간이 아직 진행 중이면 true → "지난주"
            이미 끝난 기간이면 false → "전주"
   diff: 이번 − 이전(초) / prevSec: 이전 기간 합계(초)
   (prevSec는 직전 기간 '전체' 합계다. 진행 중인 기간도 잘라 내지 않고 전체와 비교한다)
   더 집중했으면 붉은 ▲, 덜 집중했으면 파란 ▼ (style.css의 .cmpArrow). 같을 때는 화살표 없음.
   이전 기록이 없고 이번 기간 기록도 없으면 "▼ 지난주보다 0시간 0분 줄었어요" (주간·월간·연간 모두 같다)
   이전 기록이 없고 이번 기간에만 기록이 있으면 빈 문자열 → renderStatHero가 그 줄을 아예 그리지 않는다. */
function compareNote(unit, ongoing, diff, prevSec) {
  const name = COMPARE_NAMES[unit];
  const target = ongoing ? name.last : name.ended;
  const arrowOf = (up) =>
    `<i class="icon cmpArrow ${up ? "up" : "down"}" aria-hidden="true"><svg focusable="false"><use href="#i-arrow-${up ? "up" : "down"}" /></svg></i>`;

  if (prevSec <= 0) {
    const curSec = prevSec + diff; // diff = 이번 − 이전 이므로 이번 기간 합계
    return curSec <= 0
      ? `${arrowOf(false)}${target}보다 ${hl("0시간 0분")} 줄었어요`
      : "";
  }

  if (Math.abs(diff) < 60) {
    // 받침이 있으면 '과', 없으면 '와'
    const josa =
      (target.charCodeAt(target.length - 1) - 0xac00) % 28 ? "과" : "와";
    return `${target}${josa} 집중 시간이 같아요`;
  }

  const up = diff > 0;
  return `${arrowOf(up)}${target}보다 ${hl(formatDiff(Math.abs(diff)))} ${up ? "늘었어요" : "줄었어요"}`;
}

/* 날짜별 기록 + 진행 중인 집중 시간 (진행 중인 구간은 시작한 날짜 몫) */
function getLiveHistory() {
  const history = { ...focusHistoryCache };
  history[focusTotalDate] = Math.max(
    0,
    totalFocusSeconds + getCurrentFocusElapsed(),
  );
  // 하루 합계가 1분 미만이면 집중 기록으로 인정하지 않는다. (주간·월간·연간 화면 공통)
  for (const key of Object.keys(history)) {
    if (Math.floor(Number(history[key]) || 0) < 60) history[key] = 0;
  }
  return history;
}

/* 전체 기록을 아직 불러오는 중인가? (주간·월간·연간 화면이 같이 쓴다) */
function isFullHistoryLoading() {
  return !!authenticatedUser && fullHistoryLoadingFor === authenticatedUser.id;
}

/* ---------- 월간 ---------- */

function renderCalendar() {
  const today = getLocalDateKey();
  const history = getLiveHistory();
  // 전체 기록을 아직 불러오는 중이면 오늘 값만 보이지 않도록 통계는 '--', 날짜 칸의 시간은 비워 둔다.
  const loadingMonth = isFullHistoryLoading();

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
    const cls =
      "calDay" +
      (key === today ? " today" : "") +
      (key > today ? " future" : "");
    html += `<div class="${cls}"><b>${d}</b><span>${loadingMonth ? "" : formatShort(sec)}</span></div>`;
  }

  html += "<div></div>".repeat((7 - ((first + days) % 7)) % 7);

  document.getElementById("calTitle").textContent =
    `${calYear}년 ${calMonth + 1}월`;
  document.getElementById("calGrid").innerHTML = html;
  const now = new Date();
  const isThisMonth =
    calYear === now.getFullYear() && calMonth === now.getMonth();
  // 이번 달보다 뒤로는 이동할 수 없다
  document.getElementById("calNext").disabled =
    calYear * 12 + calMonth >= now.getFullYear() * 12 + now.getMonth();
  // 기록이 있는 가장 이른 달까지만 이전으로 이동할 수 있다. (주간·연간과 같은 방식)
  let minMonth = now.getFullYear() * 12 + now.getMonth();
  const firstKey = Object.keys(history)
    .filter((k) => Number(history[k]) > 0)
    .sort()[0];
  if (firstKey) {
    const [fy, fm] = firstKey.split("-").map(Number);
    minMonth = Math.min(minMonth, fy * 12 + (fm - 1));
  }
  document.getElementById("calPrev").disabled =
    calYear * 12 + calMonth <= minMonth;
  const monthLead = isThisMonth
    ? "이번 달은"
    : `${calYear !== now.getFullYear() ? `${calYear}년 ` : ""}${calMonth + 1}월은`;
  // 이번 달이든 지난 달이든, 직전 달 '전체' 합계와 비교한다. (이번 달은 아직 진행 중이어도 같다)
  const prevMonthStart = new Date(calYear, calMonth - 1, 1);
  const prevMonthDays = new Date(calYear, calMonth, 0).getDate();
  const prevMonthSum = sumDays(history, prevMonthStart, prevMonthDays);
  renderStatHero(document.getElementById("calSummary"), {
    lead: monthLead,
    total: monthTotal,
    activeDays,
    loading: loadingMonth,
    notes: [
      compareNote(
        "month",
        isThisMonth,
        monthTotal - prevMonthSum,
        prevMonthSum,
      ),
    ],
  });
}

function moveMonth(delta) {
  const d = new Date(calYear, calMonth + delta, 1);
  const now = new Date();
  if (d > new Date(now.getFullYear(), now.getMonth(), 1)) return; // 이번 달보다 뒤로는 갈 수 없다
  calYear = d.getFullYear();
  calMonth = d.getMonth();
  renderCalendar();
}

/* ---------- 주간 (막대 그래프) ---------- */

/* 그 날이 속한 주의 일요일 (월간 달력과 같이 일요일부터 시작) */
function getWeekStart(date = new Date()) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - d.getDay());
  return d;
}

/* 날짜에서 n일 뒤 날짜 */
function addDays(date, n) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
}

/* 시작일부터 count일 동안의 집중 시간 합계(초) */
function sumDays(history, startDate, count) {
  let total = 0;
  for (let i = 0; i < count; i++) {
    total += Math.floor(
      Number(history[getLocalDateKey(addDays(startDate, i))]) || 0,
    );
  }
  return total;
}

function renderWeek() {
  const today = getLocalDateKey();
  const history = getLiveHistory();
  // 전체 기록을 아직 불러오는 중이면 오늘 값만 보이지 않도록 통계는 '--', 막대는 비워 둔다.
  const loadingWeek = isFullHistoryLoading();

  const thisWeekStart = getWeekStart();
  const isThisWeek = weekStart.getTime() === thisWeekStart.getTime();
  const dow = ["일", "월", "화", "수", "목", "금", "토"];

  // 7일치 날짜와 집중 시간
  const days = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(weekStart, i);
    const key = getLocalDateKey(date);
    days.push({
      date,
      key,
      sec: Math.floor(Number(history[key]) || 0),
      future: key > today, // 아직 오지 않은 날
    });
  }

  const total = days.reduce((sum, d) => sum + d.sec, 0);
  const activeDays = days.filter((d) => d.sec > 0).length;
  const maxSec = Math.max(...days.map((d) => d.sec));

  // 막대: 이 주에서 가장 긴 날을 가장 높게 (기록이 있는 날은 최소 3% 높이로 보이게)
  const cols = days
    .map((d) => {
      const has = !loadingWeek && d.sec > 0;
      const ratio = has && maxSec > 0 ? Math.max(0.03, d.sec / maxSec) : 0;
      const level = has ? heatLevel(d.sec) : 0;
      const label = `${d.date.getMonth() + 1}월 ${d.date.getDate()}일 ${dow[d.date.getDay()]}요일`;
      const tip = has ? `${label} · ${formatKorean(d.sec)}` : label;
      const classes = ["weekCol"];
      if (d.key === today) classes.push("today");
      if (d.future) classes.push("future");
      return `<div class="${classes.join(" ")}" title="${tip}">
        <div class="weekTrack">
          <span class="weekTime">${has ? formatShort(d.sec) : ""}</span>
          <i class="weekBar l${level}" style="--p:${ratio}"></i>
        </div>
        <div class="weekLabel">
          <b class="weekDow">${dow[d.date.getDay()]}</b>
          <span class="weekDate">${d.date.getMonth() + 1}/${d.date.getDate()}</span>
        </div>
      </div>`;
    })
    .join("");
  document.getElementById("weekBars").innerHTML = cols;

  // 제목: 10월 25일 - 10월 31일 / 10월 25일 - 11월 1일 (올해가 아니면 시작 날짜 앞에 연도)
  const end = addDays(weekStart, 6);
  const yearText =
    weekStart.getFullYear() !== new Date().getFullYear()
      ? `${weekStart.getFullYear()}년 `
      : "";
  // 끝 날짜는 항상 "월 일"로 쓰고, 연도는 붙이지 않는다. (해가 바뀌는 주도 제목이 길어지지 않게)
  const endText = `${end.getMonth() + 1}월 ${end.getDate()}일`;
  document.getElementById("weekTitle").textContent =
    `${yearText}${weekStart.getMonth() + 1}월 ${weekStart.getDate()}일 - ${endText}`;

  // 지난주 비교: 이번 주든 지난 주든, 직전 주 '전체'(7일) 합계와 비교한다. (이번 주는 아직 진행 중이어도 같다)
  const curCompare = sumDays(history, weekStart, 7);
  const prevCompare = sumDays(history, addDays(weekStart, -7), 7);
  const diff = curCompare - prevCompare;

  renderStatHero(document.getElementById("weekSummary"), {
    lead: isThisWeek ? "이번 주는" : "이 주는",
    total,
    activeDays,
    loading: loadingWeek,
    notes: [compareNote("week", isThisWeek, diff, prevCompare)],
  });

  // 기록이 있는 가장 이른 주까지만 이전으로 이동, 이번 주보다 뒤로는 이동 불가
  const recordedKeys = Object.keys(history).filter(
    (k) => Number(history[k]) > 0,
  );
  let minWeekStart = thisWeekStart;
  if (recordedKeys.length > 0) {
    const first = recordedKeys.sort()[0].split("-").map(Number);
    const firstWeek = getWeekStart(new Date(first[0], first[1] - 1, first[2]));
    if (firstWeek < minWeekStart) minWeekStart = firstWeek;
  }
  weekPrevBtn.disabled = weekStart <= minWeekStart;
  weekNextBtn.disabled = weekStart >= thisWeekStart;
}

function moveWeek(delta) {
  const next = addDays(weekStart, delta * 7);
  if (next > getWeekStart()) return; // 이번 주보다 뒤로는 갈 수 없다
  weekStart = next;
  renderWeek();
}

/* ---------- 연간 (잔디) ---------- */

/*
  하루 집중 시간 → 색 단계 (연간 잔디 · 주간 막대 · 범례가 같은 기준을 쓴다)
    0단계: 기록 없음
    1단계: 1시간 미만
    2단계: 1시간 이상 ~ 3시간 미만
    3단계: 3시간 이상 ~ 5시간 미만
    4단계: 5시간 이상
  (딱 1시간 · 3시간 · 5시간이면 더 높은 단계에 들어간다)
*/
function heatLevel(sec) {
  if (sec <= 0) return 0;
  if (sec < 3600) return 1;
  if (sec < 3 * 3600) return 2;
  if (sec < 5 * 3600) return 3;
  return 4;
}

function renderYear(keepScroll = false) {
  const today = getLocalDateKey();
  const now = new Date();
  const thisYear = now.getFullYear();
  const history = getLiveHistory();

  // 전체 기록을 아직 불러오는 중이면 오늘 값만 보이지 않도록 통계는 '--', 잔디는 빈 칸으로 둔다.
  const loadingYear = isFullHistoryLoading();

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
    }

    if (date.getDate() === 1) {
      months += `<span style="--col:${Math.floor(i / 7)}">${date.getMonth() + 1}월</span>`;
    }

    const tip = !loadingYear && sec > 0 ? `${key} · ${formatKorean(sec)}` : key;
    const level = loadingYear ? 0 : heatLevel(sec);
    cells += `<div class="heatCell l${level}${key === today ? " today" : ""}" title="${tip}"></div>`;
  }

  document.getElementById("heatMonths").innerHTML = months;
  document.getElementById("heatGrid").innerHTML = cells;

  document.getElementById("yearTitle").textContent = `${yearView}년`;

  // 지난해와 비교: 올해든 지난 해든, 직전 해 '전체'(1월 1일~12월 31일) 합계와 비교한다. (올해는 아직 진행 중이어도 같다)
  const isThisYear = yearView === thisYear;
  const prevJan1 = new Date(yearView - 1, 0, 1);
  const prevEnd = new Date(yearView, 0, 0); // 전년 12월 31일
  const prevCount = Math.round((prevEnd - prevJan1) / 86400000) + 1;
  const prevSum = sumDays(history, prevJan1, prevCount);

  renderStatHero(document.getElementById("yearSummary"), {
    lead: isThisYear ? "올해는" : `${yearView}년은`,
    total,
    activeDays,
    loading: loadingYear,
    notes: [compareNote("year", isThisYear, total - prevSum, prevSum)],
  });

  // 기록이 있는 가장 이른 해까지만 이전으로 이동, 올해보다 뒤로는 이동 불가
  const years = Object.keys(history)
    .filter((k) => Number(history[k]) > 0)
    .map((k) => Number(k.slice(0, 4)));
  const minYear = Math.min(thisYear, ...years);
  yearPrevBtn.disabled = yearView <= minYear;
  yearNextBtn.disabled = yearView >= thisYear;

  // 올해는 오늘 칸이 가운데쯤 보이도록 스크롤
  const todayCell = document.querySelector("#heatGrid .today");
  // 자동 이동으로 생기는 scroll 이벤트에는 막대를 띄우지 않는다. (사용자가 직접 스크롤할 때만 표시)
  heatBarMuteUntil = Date.now() + 250;
  if (keepScroll) {
    heatScroll.scrollLeft = prevScrollLeft;
  } else {
    heatScroll.scrollLeft = todayCell
      ? Math.max(0, todayCell.offsetLeft - heatScroll.clientWidth / 2)
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
  else if (analysisMode === "week") renderWeek();
  else renderCalendar();
}

function setAnalysisMode(mode) {
  analysisMode = mode;
  const tabs = {
    week: [weekPane, tabWeekBtn],
    month: [monthPane, tabMonthBtn],
    year: [yearPane, tabYearBtn],
  };
  for (const [name, [pane, tabBtn]] of Object.entries(tabs)) {
    const on = name === mode;
    pane.hidden = !on;
    tabBtn.classList.toggle("active", on);
    tabBtn.setAttribute("aria-selected", String(on));
  }
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

  const opening = tab === "analysis" && prev !== "analysis";
  const closing = tab !== "analysis" && prev === "analysis";

  analysisView.hidden = tab !== "analysis";
  syncInert();

  if (opening) {
    /*
      분석 화면을 보는 동안에는 집중 시간이 쌓이지 않도록 집중 타이머만 조용히 멈춘다.
      (휴식 중에는 멈추지 않고 그대로 흘러간다)
    */
    if (phase === "focus") {
      analysisWasRunning = running;
      pauseQuietly();
    } else {
      analysisWasRunning = false;
    }

    document.getElementById("backToTimer").focus();

    // 분석에 들어올 때마다 연간 화면을 먼저 보여주고, 월간·주간은 이번 달·이번 주로 맞춰 둔다
    const now = new Date();
    yearView = now.getFullYear();
    calYear = now.getFullYear();
    calMonth = now.getMonth();
    weekStart = getWeekStart(now); // 주간 화면은 이번 주부터
    loadFullHistoryOnce(); // 먼저 시작해서 '불러오는 중' 상태를 만든 뒤
    setAnalysisMode("year"); // 연간 화면을 그린다
  } else if (closing) {
    // 화면을 닫으면(Esc 포함) 이어서 돌린다. 로그아웃돼서 닫힌 경우에는 돌리지 않는다.
    const shouldResume = analysisWasRunning;
    analysisWasRunning = false;
    if (shouldResume && authenticatedUser) start({ silent: true, mute: true });

    document.getElementById("openAnalysis").focus();
  }
}

document.getElementById("openAnalysis").addEventListener("click", () => {
  setTab("analysis");
});
document.getElementById("backToTimer").addEventListener("click", () => {
  setTab("focus");
});

tabWeekBtn.addEventListener("click", () => {
  if (analysisMode !== "week") setAnalysisMode("week");
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

weekPrevBtn.addEventListener("click", () => moveWeek(-1));
weekNextBtn.addEventListener("click", () => moveWeek(1));
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
     (재시도: 로그인 직후 / 인터넷이 다시 연결될 때 / 탭이 다시 보일 때 / 30초마다,
      계속 실패하면 간격을 늘려 최대 10분. 거절당하는 기록은 대기열에서 빼서 따로 보관)
   - 서버에서 기록을 불러오는 건 로그인할 때 오늘 기록 한 번, 분석 화면을 처음 열 때 전체 기록 한 번뿐이다.
     저장할 때마다 다시 불러오지 않고, 방금 저장한 기록을 화면 합계에 직접 더한다.
   - 집중하는 동안에는 10초마다 "여기까지 집중했다"를 체크포인트로 적어 둔다.
     탭을 닫거나 앱이 꺼져도 다음에 열 때 그 구간을 대기열로 옮겨 저장한다.
   ======================================== */

const PENDING_KEY = "cozyPomodoroPendingSessions";
const CHECKPOINT_KEY = "cozyPomodoroFocusCheckpoint";
const CHECKPOINT_INTERVAL_MS = 10 * 1000;
const RETRY_INTERVAL_MS = 30 * 1000;
// 저장이 계속 실패하면 재시도 간격을 2배씩 늘린다. (30초 → 1분 → 2분 … 최대 10분)
const MAX_RETRY_INTERVAL_MS = 10 * 60 * 1000;
// 서버가 영구적으로 거절한 기록을 보관하는 키 (정상 기록이 막히지 않도록 대기열에서 빼 둔다)
const REJECTED_KEY = "cozyPomodoroRejectedSessions";
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
let retryDelayMs = RETRY_INTERVAL_MS; // 다음 실패 때 적용할 대기 시간
let nextRetryAt = 0; // 이 시각 전에는 자동 재시도를 하지 않는다
let flushAgain = false;
let flushNotify = false;
let saveFailing = false;
let lastCheckpointAt = 0;

// 화면 왼쪽 위의 "저장 대기 N건" 표시. 못 올린 기록이 3초 넘게 남아 있을 때만 보인다.
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

/*
  startMs ~ endMs 구간을 DB 행으로 만든다.
  자정을 넘어도 나누지 않고 한 줄로 저장한다. (날짜는 시작 시각 기준으로 센다)
*/
function buildSessionRows(userId, startMs, endMs) {
  const seconds = Math.max(0, Math.round((endMs - startMs) / 1000));
  if (seconds <= 0) return [];

  return [
    {
      user_id: userId,
      started_at: new Date(startMs).toISOString(),
      ended_at: new Date(endMs).toISOString(),
      duration_seconds: seconds,
    },
  ];
}

/* ---------- 체크포인트 (집중 중 임시 기록) ---------- */

function writeCheckpoint(closed = false) {
  const userId = authenticatedUser?.id || lastKnownUserId;
  if (!userId || !running || phase !== "focus") return;

  const elapsed = getFocusSegmentElapsed();
  if (elapsed <= 0) return;

  const endMs = Date.now();

  writeStorageJSON(CHECKPOINT_KEY, {
    userId,
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

/*
  영구적으로 거절되는 오류인지 구분한다. (같은 기록을 다시 보내 봐야 계속 거절당함)
  22xxx: 데이터 형식 오류 / 23xxx: 제약조건 위반
  네트워크·서버 오류(5xx), 인증 만료(401), RLS(42501), 설정 오류(42P10 등)는
  기록 자체의 문제가 아니므로 영구 오류로 보지 않고 백오프로 재시도한다.
*/
function isPermanentError(error) {
  return /^(22|23)/.test(String(error?.code ?? ""));
}

/*
  결과: { ok: true } 저장됨(이미 있던 기록 포함) / { ok: false, permanent } 실패
*/
async function insertSessions(rows) {
  try {
    // upsert + ignoreDuplicates: 이미 저장된 기록은 오류 없이 건너뛴다.
    // (focus_sessions에 UNIQUE (user_id, started_at, ended_at) 제약이 있어야 동작한다)
    const { error } = await supabaseClient.from("focus_sessions").upsert(rows, {
      onConflict: "user_id,started_at,ended_at",
      ignoreDuplicates: true,
    });
    if (!error) return { ok: true, permanent: false };

    // 23505(중복): 다른 UNIQUE 인덱스에 걸린 경우. 한 줄이면 이미 저장된 기록으로 본다.
    if (error.code === "23505" && rows.length === 1) {
      return { ok: true, permanent: false };
    }

    console.error("Supabase 집중 기록 저장 실패:", error);
    return { ok: false, permanent: isPermanentError(error) };
  } catch (error) {
    console.error("Supabase 집중 기록 저장 실패:", error);
    return { ok: false, permanent: false };
  }
}

// 영구적으로 거절된 기록을 이 기기에 따로 보관한다. (최근 200건까지)
function saveRejected(rows) {
  const list = readStorageJSON(REJECTED_KEY);
  const merged = (Array.isArray(list) ? list : []).concat(rows).slice(-200);
  writeStorageJSON(REJECTED_KEY, merged);
}

async function flushOnce(userId) {
  const batch = pendingSessions.filter((r) => r.user_id === userId);
  if (!batch.length) return { saved: 0, rejected: 0, failed: false };

  const done = [];
  const rejected = [];
  let failed = false;

  const result = await insertSessions(batch);
  if (result.ok) {
    done.push(...batch);
  } else if (!result.permanent) {
    // 일시적 실패(네트워크·서버): 대기열에 그대로 두고 나중에 다시 시도한다.
    failed = true;
  } else if (batch.length === 1) {
    rejected.push(batch[0]);
  } else {
    // 어느 기록이 문제인지 모르니 한 줄씩 보내서, 정상 기록은 저장하고 문제 기록만 따로 뺀다.
    for (const row of batch) {
      const r = await insertSessions([row]);
      if (r.ok) {
        done.push(row);
      } else if (r.permanent) {
        rejected.push(row);
      } else {
        failed = true;
        break;
      }
    }
  }

  if (done.length || rejected.length) {
    // 보내는 동안 새로 쌓인 기록은 그대로 남긴다.
    pendingSessions = pendingSessions.filter(
      (r) => !done.includes(r) && !rejected.includes(r),
    );
    savePending();
    if (rejected.length) saveRejected(rejected);

    // 서버에서 다시 받아 오지 않고, 방금 저장한 기록을 화면용 합계에 직접 더한다.
    for (const row of done) addSessionToHistory(focusHistoryCache, row);
  }

  return { saved: done.length, rejected: rejected.length, failed };
}

/* 전송 중인 저장이 끝날 때까지 기다린다. (최대 maxMs) */
async function waitForFlush(maxMs = 5000) {
  const startedAt = Date.now();
  while (flushingPending && Date.now() - startedAt < maxMs) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/* 대기열을 서버로 올린다. 올린 행 수를 돌려준다. (기록은 다시 불러오지 않고 화면만 갱신한다) */
async function flushPendingSessions({ notify = false, force = false } = {}) {
  if (!authenticatedUser) return 0;
  // 연달아 실패했다면 정해진 시각 전에는 보내지 않는다.
  // (force: 집중 종료·재연결·탭 복귀·로그아웃처럼 상황이 바뀐 때는 바로 시도)
  if (!force && Date.now() < nextRetryAt) return 0;
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

    let rejected = 0;

    do {
      flushAgain = false;
      const result = await flushOnce(userId);
      saved += result.saved;
      rejected += result.rejected;
      failed = result.failed;
    } while (flushAgain && !failed);

    if (!failed) {
      // 성공했으면 대기 시간을 처음(30초)으로 되돌린다.
      retryDelayMs = RETRY_INTERVAL_MS;
      nextRetryAt = 0;
    }

    if (rejected > 0) {
      showToast(`저장할 수 없는 기록 ${rejected}건은 따로 보관했어요.`);
    }

    if (failed) {
      // 실패할 때마다 다음 재시도까지의 간격을 2배로 늘린다. (최대 10분)
      nextRetryAt = Date.now() + retryDelayMs;
      retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_INTERVAL_MS);
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
  // 로그인이 풀린 직후라도 마지막으로 알던 사용자 몫으로 대기열에 적어 둔다. (다시 로그인하면 올라간다)
  const userId = authenticatedUser?.id || lastKnownUserId;

  if (!userId) {
    showToast("로그인이 필요해 집중 기록을 저장하지 못했어요.");
    return;
  }

  const rows = buildSessionRows(userId, startMs, endMs);
  if (!rows.length) return;

  // 여기까지는 await 전이라 즉시 실행된다. 탭을 바로 닫아도 기기에는 남는다.
  pendingSessions.push(...rows);
  savePending();

  await flushPendingSessions({ notify: true, force: true });
}

window.addEventListener("online", () => flushPendingSessions({ force: true }));
// 보낼 기록이 있을 때만 요청이 나간다. 실패가 이어지면 nextRetryAt까지 건너뛴다. (30초 → … → 최대 10분)
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

/* 기록 한 줄을 날짜별 합계(초)에 더한다. 자정을 넘어도 시작한 날짜에 전부 더한다. */
function addSessionToHistory(history, row) {
  const start = new Date(row.started_at).getTime();
  const end = new Date(row.ended_at).getTime();
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  const day = getLocalDateKey(new Date(start));

  history[day] = (history[day] || 0) + seconds;
}

/*
  분석 화면용 전체 기록은 DB 함수 daily_focus가 날짜별 합계(하루 1줄)로 보내 준다.
  함수가 아직 만들어지지 않았다면 예전 방식(모든 행을 받아 와서 여기서 합산)으로 대신한다.
*/
let dailyRpcAvailable = true;

function isMissingFunctionError(error) {
  return (
    error?.code === "PGRST202" ||
    error?.status === 404 ||
    /Could not find the function/i.test(String(error?.message ?? ""))
  );
}

async function fetchDailyHistory() {
  try {
    const timeZone =
      Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Seoul";
    const { data, error } = await supabaseClient.rpc("daily_focus", {
      tz: timeZone,
    });
    if (error) return { history: null, error };

    const history = {};
    for (const row of data || []) {
      history[String(row.day).slice(0, 10)] = Number(row.seconds) || 0;
    }
    return { history, error: null };
  } catch (error) {
    return { history: null, error };
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

  let history = null;

  // 전체 기록: 먼저 DB 함수(날짜별 합계)를 시도한다.
  if (full && dailyRpcAvailable) {
    const result = await fetchDailyHistory();

    if (token !== historyLoadToken) return false;

    if (result.history) {
      history = result.history;
    } else {
      // 함수가 없으면 앞으로는 시도하지 않는다. 일시적인 오류면 이번만 예전 방식으로 대신한다.
      if (isMissingFunctionError(result.error)) dailyRpcAvailable = false;
      console.warn(
        "daily_focus 사용 불가, 전체 행 조회로 대신합니다:",
        result.error,
      );
    }
  }

  if (!history) {
    const { data, error } = await fetchAllFocusSessions(userId, sinceIso);

    if (token !== historyLoadToken) return false;

    if (error) {
      console.error("Supabase 집중 기록 불러오기 실패:", error);
      showToast("집중 기록을 불러오지 못했어요.");
      return false;
    }

    history = {};
    for (const row of data) addSessionToHistory(history, row);
  }

  focusHistoryCache = history;

  // 오늘 누적 시간은 로그인 때(오늘 기록)에 맞춘다. 분석 화면에서 전체를 불러올 때는
  // 오늘 기록을 아직 못 불러온 경우에만 맞춘다.
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
  // 불러오는 중 표시를 끈 뒤 한 번 더 그린다.
  renderAnalysis(true);
}

/* ---------- 설정 동기화 (Supabase user_settings 테이블) ---------- */

/*
  집중·짧은 휴식·긴 휴식 시간을 계정에 저장해서 기기마다 같은 설정을 쓴다.
  - 저장할 때: 이 기기(localStorage)에 먼저 저장하고, 서버에도 올린다.
    서버 저장에 실패하면 "아직 못 올림" 표시를 남겨 두었다가 다음 로그인 때 다시 올린다.
  - 로그인할 때: 서버에 설정이 있으면 가져와서 적용하고, 서버에 설정이 없으면 이 기기의 설정을 올린다.
  - user_settings 테이블이 아직 없으면 조용히 건너뛴다. (이 기기의 설정만 계속 쓴다)
*/
const SETTINGS_DIRTY_KEY = "cozyPomodoroSettingsDirty";
let settingsSyncedFor = null; // 서버 설정과 맞춰 본 사용자
let settingsSyncingFor = null; // 맞춰 보는 중인 사용자

/*
  "아직 못 올림" 표시에는 어느 계정의 설정인지(userId)를 함께 적는다.
  같은 기기에서 다른 계정으로 로그인해도 서로의 설정이 섞이지 않게 하기 위함이다.
  userId가 null이면 표시를 지운다.
*/
function setSettingsDirty(userId) {
  try {
    if (userId) localStorage.setItem(SETTINGS_DIRTY_KEY, userId);
    else localStorage.removeItem(SETTINGS_DIRTY_KEY);
  } catch (_) {
    // 저장소를 못 쓰는 환경에서는 표시 없이 넘어간다.
  }
}

function isSettingsDirty(userId) {
  try {
    return localStorage.getItem(SETTINGS_DIRTY_KEY) === userId;
  } catch (_) {
    return false;
  }
}

async function pushSettingsToServer() {
  // 로그인이 풀린 직후라도 마지막으로 알던 사용자 몫으로 표시를 남긴다. (다시 로그인하면 올라간다)
  const dirtyUserId = authenticatedUser?.id || lastKnownUserId;
  if (dirtyUserId) setSettingsDirty(dirtyUserId);
  if (!authenticatedUser) return false;

  try {
    // 설정값은 저장·불러오기 단계에서 이미 정수로 검증된다.
    const { error } = await supabaseClient.from("user_settings").upsert({
      user_id: authenticatedUser.id,
      focus_minutes: settings.focusMinutes,
      break_minutes: settings.breakMinutes,
      long_break_minutes: settings.longBreakMinutes,
      updated_at: new Date().toISOString(),
    });
    if (error) throw error;

    setSettingsDirty(null);
    return true;
  } catch (error) {
    console.warn(
      "설정을 서버에 저장하지 못했어요. (이 기기에는 저장됨)",
      error,
    );
    return false;
  }
}

/* 서버에서 가져온 설정을 적용한다. 돌아가는 중인 타이머는 건드리지 않고, 다음 단계부터 새 값을 쓴다. */
function applyRemoteSettings(remote) {
  if (
    remote.focusMinutes === settings.focusMinutes &&
    remote.breakMinutes === settings.breakMinutes &&
    remote.longBreakMinutes === settings.longBreakMinutes
  ) {
    return;
  }

  settings = remote;

  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {
    console.warn("설정 저장 실패:", e);
  }

  // 아직 시작하지 않은 상태라면 화면의 시간도 새 설정으로 맞춘다.
  if (!running && !settingsOpen && remaining === duration) {
    if (isLongBreak && settings.longBreakMinutes === 0) isLongBreak = false;

    duration = getPhaseSeconds();
    remaining = duration;
    render();
  }

  showToast("저장된 설정을 불러왔어요");
}

async function syncSettingsOnce() {
  if (!authenticatedUser) return;

  const userId = authenticatedUser.id;
  if (settingsSyncedFor === userId || settingsSyncingFor === userId) return;

  settingsSyncingFor = userId;

  try {
    const { data, error } = await supabaseClient
      .from("user_settings")
      .select("focus_minutes,break_minutes,long_break_minutes")
      .eq("user_id", userId)
      .maybeSingle();

    if (authenticatedUser?.id !== userId) return;

    if (error) {
      // 테이블이 아직 없거나 네트워크 문제: 이 기기의 설정을 그대로 쓰고 다음 로그인 알림 때 다시 시도한다.
      console.warn("서버 설정을 불러오지 못했어요:", error);
      return;
    }

    if (!data || isSettingsDirty(userId)) {
      // 서버에 설정이 없거나, 이 기기에서 바꾼 설정이 아직 서버에 못 올라간 상태 → 이 기기 설정을 올린다.
      await pushSettingsToServer();
    } else {
      const remote = parseSettings({
        focusMinutes: data.focus_minutes,
        breakMinutes: data.break_minutes,
        longBreakMinutes: data.long_break_minutes,
      });
      if (remote) {
        // 남아 있는 "못 올림" 표시는 다른 계정 몫이다. 이 기기 설정이 이 계정 설정으로 바뀌므로 지운다.
        setSettingsDirty(null);
        applyRemoteSettings(remote);
      }
    }

    settingsSyncedFor = userId;
  } catch (error) {
    console.warn("설정 동기화 중 오류:", error);
  } finally {
    if (settingsSyncingFor === userId) settingsSyncingFor = null;
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
    submit.textContent = "로그인하기";
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
    }
    // 성공하면 onAuthStateChange가 로그인 창을 숨기고 메시지를 비우므로 따로 알리지 않는다.
  });

  logout.addEventListener("click", async () => {
    if (running) pause();
    // 저장이 끝난 뒤에 로그아웃해야 방금 집중한 기록이 거절당하지 않는다.
    await waitForFlush();
    await flushPendingSessions({ force: true });
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
        lastKnownUserId = authenticatedUser.id;
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
          // 밀려 있던 기록을 먼저 올린 뒤, 오늘 기록은 사용자당 한 번만 불러온다.
          await flushPendingSessions();
          // 오늘 기록과 서버 설정은 서로 기다릴 필요가 없으니 함께 불러온다.
          await Promise.all([loadHistoryOnce(), syncSettingsOnce()]);
        } finally {
          // 다른 알림이 아직 불러오는 중이면 계속 잠가 둔다. (불러오기에 실패해도 시작은 할 수 있다)
          startBtn.disabled = historyLoadingFor !== null;
        }
        render();
      } else {
        // 로그인이 풀렸는데 타이머가 돌고 있으면 멈춘다.
        // 지금까지의 집중은 마지막으로 알던 사용자 몫으로 대기열에 남고, 다시 로그인하면 저장된다.
        if (running) {
          pauseQuietly();
          showToast("로그인이 풀려서 타이머를 멈췄어요.");
        }

        historyLoadToken++;
        historyLoadedFor = null;
        historyLoadingFor = null;
        fullHistoryFor = null;
        fullHistoryLoadingFor = null;
        settingsSyncedFor = null;
        settingsSyncingFor = null;
        setTab("focus");
        focusHistoryCache = {};

        // 로그아웃한 사람의 누적 시간이 화면에 남지 않도록 비운다. (타이머가 도는 중이면 건드리지 않는다)
        if (!running) {
          totalFocusSeconds = 0;
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
      }
    }, 0);
  });
}

initializeSupabaseAuth();
