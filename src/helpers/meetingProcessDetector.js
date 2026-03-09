const { exec } = require("child_process");
const { promisify } = require("util");
const EventEmitter = require("events");
const debugLogger = require("./debugLogger");

const execAsync = promisify(exec);

const POLL_INTERVAL_MS = 20 * 1000;
const EXEC_OPTS = { timeout: 3000, encoding: "utf8" };

async function hasProcess(name) {
  try {
    await execAsync(`pgrep -f "${name}"`, EXEC_OPTS);
    return true;
  } catch {
    return false;
  }
}

async function hasProcessExact(name) {
  try {
    await execAsync(`pgrep -x "${name}"`, EXEC_OPTS);
    return true;
  } catch {
    return false;
  }
}

async function hasActiveAudio(appName) {
  if (process.platform !== "darwin") return true;
  try {
    const { stdout } = await execAsync(
      `lsof -c "${appName}" 2>/dev/null | grep -i coreaudio`,
      EXEC_OPTS
    );
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

const MEETING_APPS = {
  darwin: [
    { processKey: "zoom", appName: "Zoom", check: () => hasProcessExact("CptHost") },
    {
      processKey: "teams",
      appName: "Microsoft Teams",
      check: async () => (await hasProcess("MSTeams")) && (await hasActiveAudio("MSTeams")),
    },
    {
      processKey: "facetime",
      appName: "FaceTime",
      check: async () => (await hasProcessExact("FaceTime")) && (await hasActiveAudio("FaceTime")),
    },
    { processKey: "webex", appName: "Webex", check: () => hasProcess("webexmeetingsapp") },
  ],
  // Windows: single tasklist call in _pollWin32() to avoid per-app process spawns.
  win32: [
    { processKey: "zoom", appName: "Zoom", imageName: "cpthost.exe" },
    { processKey: "teams", appName: "Microsoft Teams", imageName: "ms-teams_modulehost.exe" },
    { processKey: "webex", appName: "Webex", imageName: "webexmeetingsapp.exe" },
  ],
  linux: [
    { processKey: "zoom", appName: "Zoom", check: () => hasProcess("zoom") },
    { processKey: "teams", appName: "Microsoft Teams", check: () => hasProcess("teams") },
  ],
};

class MeetingProcessDetector extends EventEmitter {
  constructor() {
    super();
    this.pollInterval = null;
    this.detectedProcesses = new Map();
    this.dismissedProcesses = new Set();
    this._polling = false;
  }

  start() {
    if (this.pollInterval) return;
    const apps = MEETING_APPS[process.platform] || [];
    debugLogger.info(
      "Process detector started",
      {
        platform: process.platform,
        appsMonitored: apps.map((a) => a.appName),
        intervalMs: POLL_INTERVAL_MS,
      },
      "meeting"
    );
    this._poll();
    this.pollInterval = setInterval(() => this._poll(), POLL_INTERVAL_MS);
  }

  stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.detectedProcesses.clear();
    debugLogger.info("Stopped meeting process detector", {}, "meeting");
  }

  dismiss(processKey) {
    this.dismissedProcesses.add(processKey);
    debugLogger.info("Process detection dismissed", { processKey }, "meeting");
  }

  getDetectedProcesses() {
    return Array.from(this.detectedProcesses.entries()).map(([processKey, { detectedAt }]) => ({
      processKey,
      appName: this._getAppName(processKey),
      detectedAt,
    }));
  }

  _getAppName(processKey) {
    const apps = MEETING_APPS[process.platform] || [];
    const entry = apps.find((a) => a.processKey === processKey);
    return entry ? entry.appName : processKey;
  }

  async _poll() {
    if (this._polling) return;
    this._polling = true;
    try {
      if (process.platform === "win32") {
        await this._pollWin32();
      } else {
        await this._pollDefault();
      }
    } catch (err) {
      debugLogger.warn("Poll error", { error: err.message }, "meeting");
    } finally {
      this._polling = false;
    }
  }

  async _pollWin32() {
    const apps = MEETING_APPS.win32 || [];
    let tasklistOutput = "";
    try {
      const { stdout } = await execAsync("tasklist /NH /FO CSV", EXEC_OPTS);
      tasklistOutput = stdout.toLowerCase();
    } catch {
      return;
    }

    for (const { processKey, appName, imageName } of apps) {
      const isRunning = tasklistOutput.includes(`"${imageName}"`);
      this._updateDetection(processKey, appName, isRunning);
    }
  }

  async _pollDefault() {
    const apps = MEETING_APPS[process.platform] || [];

    for (const { processKey, appName, check } of apps) {
      let isRunning = false;
      try {
        isRunning = await check();
      } catch {
        isRunning = false;
      }
      this._updateDetection(processKey, appName, isRunning);
    }
  }

  _updateDetection(processKey, appName, isRunning) {
    if (isRunning) {
      if (!this.detectedProcesses.has(processKey) && !this.dismissedProcesses.has(processKey)) {
        const detectedAt = Date.now();
        this.detectedProcesses.set(processKey, { detectedAt });
        debugLogger.info("Meeting process detected", { processKey, appName }, "meeting");
        this.emit("meeting-process-detected", { processKey, appName, detectedAt });
      }
    } else if (this.detectedProcesses.has(processKey)) {
      this.detectedProcesses.delete(processKey);
      debugLogger.info("Meeting process ended", { processKey, appName }, "meeting");
      this.emit("meeting-process-ended", { processKey, appName });
    }
  }
}

module.exports = MeetingProcessDetector;
