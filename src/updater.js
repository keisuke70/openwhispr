const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { autoUpdater } = require("electron-updater");

class UpdateManager {
  constructor() {
    this.mainWindow = null;
    this.controlPanelWindow = null;
    this.updateAvailable = false;
    this.updateDownloaded = false;
    this.lastUpdateInfo = null;
    this.isInstalling = false;
    this.isDownloading = false;
    this.eventListeners = [];
    this.updateCheckInterval = null;
    this.windowManager = null;
    this._suppressNotification = false;
    this.updaterEnabled = false;
    this.updaterDisabledReason = null;

    this.setupAutoUpdater();
  }

  setWindows(mainWindow, controlPanelWindow) {
    this.mainWindow = mainWindow;
    this.controlPanelWindow = controlPanelWindow;
  }

  setWindowManager(windowManager) {
    this.windowManager = windowManager;
  }

  resolveUpdaterAvailability() {
    if (process.env.NODE_ENV === "development") {
      return {
        enabled: false,
        reason: "development",
        detail: "Running in development mode",
      };
    }

    const updateConfigPath = path.join(process.resourcesPath || "", "app-update.yml");
    if (!process.resourcesPath || !fs.existsSync(updateConfigPath)) {
      return {
        enabled: false,
        reason: "local_build",
        detail: "Missing app-update.yml in app resources",
      };
    }

    if (process.platform === "darwin") {
      const codesign = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", process.execPath], {
        encoding: "utf8",
      });
      const output = `${codesign.stdout || ""}\n${codesign.stderr || ""}`;
      if (/Signature=adhoc/i.test(output)) {
        return {
          enabled: false,
          reason: "local_build",
          detail: "App is ad hoc signed",
        };
      }
    }

    return {
      enabled: true,
      reason: null,
      detail: null,
    };
  }

  getUpdaterDisabledMessage() {
    if (this.updaterDisabledReason === "development") {
      return "In-app updates are disabled in development mode";
    }

    return "In-app updates are disabled for local builds. Pull the latest changes and rebuild the app instead.";
  }

  setupAutoUpdater() {
    const availability = this.resolveUpdaterAvailability();
    this.updaterEnabled = availability.enabled;
    this.updaterDisabledReason = availability.reason;

    if (!this.updaterEnabled) {
      console.log(
        `ℹ️ In-app updater disabled (${availability.reason || "unknown"}): ${availability.detail || "no additional detail"}`
      );
      return;
    }

    autoUpdater.setFeedURL({
      provider: "github",
      owner: "OpenWhispr",
      repo: "openwhispr",
      private: false,
    });

    // Use arch-specific update channel on macOS to prevent arm64/x64
    // from downloading mismatched artifacts. Both builds publish to the
    // same GitHub release, so without this they race on latest-mac.yml.
    // Setting channel to e.g. 'latest-arm64' makes the updater look for
    // 'latest-arm64-mac.yml' instead of the shared 'latest-mac.yml'.
    if (process.platform === "darwin") {
      let nativeArch = process.arch;

      // Detect Rosetta: if an x64 build is running on Apple Silicon,
      // sysctl.proc_translated returns "1". This self-heals users who
      // got stuck on the x64 build from older releases.
      if (process.arch === "x64") {
        try {
          const { execSync } = require("child_process");
          const translated = execSync("sysctl -n sysctl.proc_translated", {
            encoding: "utf8",
            timeout: 3000,
          }).trim();
          if (translated === "1") {
            console.log("🔄 Rosetta detected — switching update channel to arm64");
            nativeArch = "arm64";
          }
        } catch {
          // sysctl.proc_translated doesn't exist on real Intel Macs — ignore
        }
      }

      autoUpdater.channel = nativeArch === "arm64" ? "latest-arm64" : "latest-x64";
    }

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = console;

    this.setupEventHandlers();
  }

  setupEventHandlers() {
    const handlers = {
      "checking-for-update": () => {
        this.notifyRenderers("checking-for-update");
      },
      "update-available": (info) => {
        this.updateAvailable = true;
        if (info) {
          this.lastUpdateInfo = {
            version: info.version,
            releaseDate: info.releaseDate,
            releaseNotes: info.releaseNotes,
            files: info.files,
          };
        }
        this.notifyRenderers("update-available", info);
        if (this.windowManager && info && !this._suppressNotification) {
          this.windowManager.showUpdateNotification(info).catch((err) => {
            console.error("Failed to show update notification:", err);
          });
        }
        this._suppressNotification = false;
      },
      "update-not-available": (info) => {
        this.updateAvailable = false;
        this._suppressNotification = false;
        if (!this.updateDownloaded) {
          this.isDownloading = false;
          this.lastUpdateInfo = null;
        }
        this.notifyRenderers("update-not-available", info);
      },
      error: (err) => {
        console.error("❌ Auto-updater error:", err);
        this._suppressNotification = false;
        this.isDownloading = false;
        this.notifyRenderers("update-error", err);
      },
      "download-progress": (progressObj) => {
        console.log(
          `📥 Download progress: ${progressObj.percent.toFixed(2)}% (${(progressObj.transferred / 1024 / 1024).toFixed(2)}MB / ${(progressObj.total / 1024 / 1024).toFixed(2)}MB)`
        );
        this.notifyRenderers("update-download-progress", progressObj);
      },
      "update-downloaded": (info) => {
        console.log("✅ Update downloaded successfully:", info?.version);
        this.updateDownloaded = true;
        this.isDownloading = false;
        if (info) {
          this.lastUpdateInfo = {
            version: info.version,
            releaseDate: info.releaseDate,
            releaseNotes: info.releaseNotes,
            files: info.files,
          };
        }
        this.notifyRenderers("update-downloaded", info);
      },
    };

    Object.entries(handlers).forEach(([event, handler]) => {
      autoUpdater.on(event, handler);
      this.eventListeners.push({ event, handler });
    });
  }

  notifyRenderers(channel, data) {
    if (this.mainWindow && !this.mainWindow.isDestroyed() && this.mainWindow.webContents) {
      this.mainWindow.webContents.send(channel, data);
    }
    if (
      this.controlPanelWindow &&
      !this.controlPanelWindow.isDestroyed() &&
      this.controlPanelWindow.webContents
    ) {
      this.controlPanelWindow.webContents.send(channel, data);
    }
  }

  async checkForUpdates() {
    try {
      if (!this.updaterEnabled) {
        return {
          updateAvailable: false,
          message: this.getUpdaterDisabledMessage(),
        };
      }

      console.log("🔍 Checking for updates...");
      this._suppressNotification = true;
      const result = await autoUpdater.checkForUpdates();

      if (result?.isUpdateAvailable && result?.updateInfo) {
        console.log("📋 Update available:", result.updateInfo.version);
        return {
          updateAvailable: true,
          version: result.updateInfo.version,
          releaseDate: result.updateInfo.releaseDate,
          files: result.updateInfo.files,
          releaseNotes: result.updateInfo.releaseNotes,
        };
      } else {
        console.log("✅ Already on latest version");
        return {
          updateAvailable: false,
          message: "You are running the latest version",
        };
      }
    } catch (error) {
      console.error("❌ Update check error:", error);
      throw error;
    }
  }

  async downloadUpdate() {
    try {
      if (!this.updaterEnabled) {
        return {
          success: false,
          message: this.getUpdaterDisabledMessage(),
        };
      }

      if (this.isDownloading) {
        return {
          success: true,
          message: "Download already in progress",
        };
      }

      if (this.updateDownloaded) {
        return {
          success: true,
          message: "Update already downloaded. Ready to install.",
        };
      }

      this.isDownloading = true;
      console.log("📥 Starting update download...");
      await autoUpdater.downloadUpdate();
      console.log("📥 Download initiated successfully");

      return { success: true, message: "Update download started" };
    } catch (error) {
      this.isDownloading = false;
      console.error("❌ Update download error:", error);
      throw error;
    }
  }

  async installUpdate() {
    try {
      if (!this.updaterEnabled) {
        return {
          success: false,
          message: this.getUpdaterDisabledMessage(),
        };
      }

      if (!this.updateDownloaded) {
        return {
          success: false,
          message: "No update available to install",
        };
      }

      if (this.isInstalling) {
        return {
          success: false,
          message: "Update installation already in progress",
        };
      }

      this.isInstalling = true;
      console.log("🔄 Installing update and restarting...");

      const { app, BrowserWindow } = require("electron");

      // Set windowManager.isQuitting before removing close listeners
      app.emit("before-quit");
      app.removeAllListeners("window-all-closed");
      BrowserWindow.getAllWindows().forEach((win) => {
        win.removeAllListeners("close");
      });

      const isSilent = process.platform === "win32";
      autoUpdater.quitAndInstall(isSilent, true);

      return { success: true, message: "Update installation started" };
    } catch (error) {
      this.isInstalling = false;
      console.error("❌ Update installation error:", error);
      throw error;
    }
  }

  async getAppVersion() {
    try {
      const { app } = require("electron");
      return { version: app.getVersion() };
    } catch (error) {
      console.error("❌ Error getting app version:", error);
      throw error;
    }
  }

  async getUpdateStatus() {
    try {
      return {
        updateAvailable: this.updateAvailable,
        updateDownloaded: this.updateDownloaded,
        isDevelopment: process.env.NODE_ENV === "development",
        updaterEnabled: this.updaterEnabled,
        updaterDisabledReason: this.updaterDisabledReason,
      };
    } catch (error) {
      console.error("❌ Error getting update status:", error);
      throw error;
    }
  }

  async getUpdateInfo() {
    try {
      return this.lastUpdateInfo;
    } catch (error) {
      console.error("❌ Error getting update info:", error);
      throw error;
    }
  }

  checkForUpdatesOnStartup() {
    if (this.updaterEnabled) {
      setTimeout(() => {
        console.log("🔄 Checking for updates on startup...");
        autoUpdater.checkForUpdates().catch((err) => {
          console.error("Startup update check failed:", err);
        });
      }, 3000);

      const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
      this.updateCheckInterval = setInterval(() => {
        console.log("🔄 Periodic update check...");
        autoUpdater.checkForUpdates().catch((err) => {
          console.error("Periodic update check failed:", err);
        });
      }, FOUR_HOURS_MS);
    }
  }

  cleanup() {
    if (this.updateCheckInterval) {
      clearInterval(this.updateCheckInterval);
      this.updateCheckInterval = null;
    }
    this.eventListeners.forEach(({ event, handler }) => {
      autoUpdater.removeListener(event, handler);
    });
    this.eventListeners = [];
  }
}

module.exports = UpdateManager;
