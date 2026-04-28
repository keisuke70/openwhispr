const WebSocket = require("ws");
const debugLogger = require("./debugLogger");

const WEBSOCKET_TIMEOUT_MS = 15000;
const DISCONNECT_TIMEOUT_MS = 5000;
const SAMPLE_RATE = 24000;
const COLD_START_BUFFER_MAX = 3 * SAMPLE_RATE * 2; // 3 seconds of 16-bit PCM
const REPLAY_BUFFER_MAX = 6 * SAMPLE_RATE * 2; // 6 seconds of recent audio
const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 4000;
const MAX_RECONNECT_ATTEMPTS = 4;

class OpenAIRealtimeStreaming {
  constructor() {
    this.ws = null;
    this.isConnected = false;
    this.isConnecting = false;
    this.completedSegments = [];
    this.currentPartial = "";
    this.onPartialTranscript = null;
    this.onFinalTranscript = null;
    this.onError = null;
    this.onSessionEnd = null;
    this.onConnectionStateChange = null;
    this.pendingResolve = null;
    this.pendingReject = null;
    this.connectionTimeout = null;
    this.isDisconnecting = false;
    this.audioBytesSent = 0;
    this.model = "gpt-4o-mini-transcribe";
    this.preconfigured = false;
    this.coldStartBuffer = [];
    this.coldStartBufferSize = 0;
    this.replayBuffer = [];
    this.replayBufferSize = 0;
    this.speechStartedAt = null;
    this.connectionOptions = null;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.activeConnectPromise = null;
    this.connectionState = "disconnected";
    this.hasSentAudioSinceConnect = false;
    this.hasDetectedSpeech = false;
  }

  getFullTranscript() {
    return this.completedSegments.join(" ");
  }

  setConnectionState(state, meta = {}) {
    this.connectionState = state;
    this.onConnectionStateChange?.({
      state,
      ...meta,
    });
  }

  clearPendingConnect() {
    clearTimeout(this.connectionTimeout);
    this.connectionTimeout = null;
    this.pendingResolve = null;
    this.pendingReject = null;
  }

  resolvePendingConnect() {
    const resolve = this.pendingResolve;
    this.clearPendingConnect();
    resolve?.();
  }

  rejectPendingConnect(error) {
    const reject = this.pendingReject;
    this.clearPendingConnect();
    reject?.(error);
  }

  cleanupSocket(socket = this.ws, { close = false } = {}) {
    if (!socket) return;

    try {
      socket.removeAllListeners();
    } catch {}

    if (close) {
      try {
        socket.close();
      } catch {}
    }

    if (this.ws === socket) {
      this.ws = null;
    }
  }

  queueBufferedAudio(pcmBuffer) {
    const copy = Buffer.from(pcmBuffer);
    this.coldStartBuffer.push(copy);
    this.coldStartBufferSize += copy.length;

    while (this.coldStartBufferSize > COLD_START_BUFFER_MAX && this.coldStartBuffer.length > 0) {
      const dropped = this.coldStartBuffer.shift();
      this.coldStartBufferSize -= dropped?.length || 0;
    }
  }

  rememberReplayAudio(pcmBuffer) {
    const copy = Buffer.from(pcmBuffer);
    this.replayBuffer.push(copy);
    this.replayBufferSize += copy.length;

    while (this.replayBufferSize > REPLAY_BUFFER_MAX && this.replayBuffer.length > 0) {
      const dropped = this.replayBuffer.shift();
      this.replayBufferSize -= dropped?.length || 0;
    }
  }

  resetReplayBuffer() {
    this.replayBuffer = [];
    this.replayBufferSize = 0;
  }

  getReplayBufferCopy() {
    return this.replayBuffer.map((buf) => Buffer.from(buf));
  }

  flushBufferedAudio() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.coldStartBuffer.length === 0) {
      return;
    }

    debugLogger.debug("OpenAI Realtime flushing buffered audio", {
      chunks: this.coldStartBuffer.length,
      bytes: this.coldStartBufferSize,
    });

    for (const buf of this.coldStartBuffer) {
      const b64 = buf.toString("base64");
      this.ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
      this.audioBytesSent += buf.length;
    }

    this.coldStartBuffer = [];
    this.coldStartBufferSize = 0;
  }

  scheduleReconnect(error) {
    if (this.isDisconnecting || !this.connectionOptions) {
      this.setConnectionState("failed", { error: error.message });
      this.onError?.(error);
      return;
    }

    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      debugLogger.error("OpenAI Realtime reconnect exhausted", {
        attempts: this.reconnectAttempts,
        error: error.message,
      });
      this.setConnectionState("failed", {
        error: error.message,
        attempt: this.reconnectAttempts,
        maxAttempts: MAX_RECONNECT_ATTEMPTS,
      });
      this.onError?.(error);
      return;
    }

    if (this.reconnectTimer || this.activeConnectPromise) {
      return;
    }

    this.reconnectAttempts += 1;
    const attempt = this.reconnectAttempts;
    const delayMs = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1),
      RECONNECT_MAX_DELAY_MS
    );
    const replayBuffer = this.getReplayBufferCopy();
    const replayBytes = replayBuffer.reduce((sum, buf) => sum + buf.length, 0);

    this.currentPartial = "";
    this.onPartialTranscript?.("");
    this.setConnectionState("reconnecting", {
      attempt,
      maxAttempts: MAX_RECONNECT_ATTEMPTS,
      delayMs,
      error: error.message,
    });

    debugLogger.warn("OpenAI Realtime scheduling reconnect", {
      attempt,
      delayMs,
      replayChunks: replayBuffer.length,
      replayBytes,
      error: error.message,
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect({
        ...this.connectionOptions,
        preserveTranscript: true,
        replayBuffer,
        isReconnect: true,
      }).catch((connectError) => {
        debugLogger.error("OpenAI Realtime reconnect attempt failed", {
          attempt,
          error: connectError.message,
        });
        this.scheduleReconnect(connectError);
      });
    }, delayMs);
  }

  async connect(options = {}) {
    const {
      apiKey,
      model,
      preconfigured,
      preserveTranscript = false,
      replayBuffer = null,
      isReconnect = false,
    } = options;
    if (!apiKey) throw new Error("OpenAI API key is required");

    if (this.isConnected) {
      debugLogger.debug("OpenAI Realtime already connected");
      return;
    }

    if (this.activeConnectPromise) {
      debugLogger.debug("OpenAI Realtime connect already in progress");
      return this.activeConnectPromise;
    }

    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;

    this.isConnecting = true;
    this.model = model || "gpt-4o-mini-transcribe";
    this.preconfigured = !!preconfigured;
    this.connectionOptions = {
      apiKey,
      model: this.model,
      preconfigured: this.preconfigured,
    };

    if (!preserveTranscript) {
      this.completedSegments = [];
      this.currentPartial = "";
      this.audioBytesSent = 0;
      this.coldStartBuffer = [];
      this.coldStartBufferSize = 0;
      this.resetReplayBuffer();
      this.reconnectAttempts = 0;
      this.hasSentAudioSinceConnect = false;
      this.hasDetectedSpeech = false;
    } else if (Array.isArray(replayBuffer) && replayBuffer.length > 0) {
      const queuedDuringReconnect = this.coldStartBuffer;
      this.coldStartBuffer = replayBuffer.map((buf) => Buffer.from(buf));
      for (const buf of queuedDuringReconnect) {
        this.coldStartBuffer.push(Buffer.from(buf));
      }
      this.coldStartBufferSize = this.coldStartBuffer.reduce((sum, buf) => sum + buf.length, 0);
      while (this.coldStartBufferSize > COLD_START_BUFFER_MAX && this.coldStartBuffer.length > 0) {
        const dropped = this.coldStartBuffer.shift();
        this.coldStartBufferSize -= dropped?.length || 0;
      }
      this.hasSentAudioSinceConnect = replayBuffer.length > 0;
    }

    this.speechStartedAt = null;

    const url = "wss://api.openai.com/v1/realtime?intent=transcription";
    debugLogger.debug("OpenAI Realtime connecting", {
      model: this.model,
      isReconnect,
      bufferedChunks: this.coldStartBuffer.length,
    });
    this.setConnectionState(isReconnect ? "reconnecting" : "connecting", {
      attempt: isReconnect ? this.reconnectAttempts : 0,
      maxAttempts: MAX_RECONNECT_ATTEMPTS,
    });

    const connectPromise = new Promise((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;

      this.connectionTimeout = setTimeout(() => {
        const err = new Error("OpenAI Realtime connection timeout");
        this.isConnecting = false;
        this.isConnected = false;
        this.cleanupSocket(this.ws, { close: true });
        this.rejectPendingConnect(err);
        if (isReconnect) {
          this.scheduleReconnect(err);
        } else {
          this.setConnectionState("failed", { error: err.message });
        }
      }, WEBSOCKET_TIMEOUT_MS);

      const socket = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "OpenAI-Beta": "realtime=v1",
        },
      });
      this.ws = socket;

      socket.on("open", () => {
        if (this.ws !== socket) return;
        debugLogger.debug("OpenAI Realtime WebSocket opened");
      });

      socket.on("message", (data) => {
        if (this.ws !== socket) return;
        this.handleMessage(data);
      });

      socket.on("error", (error) => {
        if (this.ws !== socket) return;
        debugLogger.error("OpenAI Realtime WebSocket error", { error: error.message });
        if (!this.isConnected) {
          this.isConnecting = false;
          this.isConnected = false;
          this.cleanupSocket(socket, { close: true });
          this.rejectPendingConnect(error);
          if (isReconnect) {
            this.scheduleReconnect(error);
          } else {
            this.setConnectionState("failed", { error: error.message });
          }
        }
      });

      socket.on("close", (code, reason) => {
        if (this.ws !== socket && this.connectionState !== "reconnecting") return;

        const wasActive = this.isConnected;
        const reasonText = reason?.toString();
        this.isConnecting = false;
        this.isConnected = false;
        this.cleanupSocket(socket);
        debugLogger.debug("OpenAI Realtime WebSocket closed", {
          code,
          reason: reasonText,
          wasActive,
          reconnectAttempts: this.reconnectAttempts,
        });

        if (this.pendingReject) {
          const err = new Error(`WebSocket closed before ready (code: ${code})`);
          this.rejectPendingConnect(err);
          if (isReconnect) {
            this.scheduleReconnect(err);
          } else {
            this.setConnectionState("failed", { error: err.message });
          }
          return;
        }

        if (wasActive && !this.isDisconnecting) {
          if (!this.hasSentAudioSinceConnect) {
            debugLogger.debug("OpenAI Realtime idle warm connection closed", {
              code,
              reason: reasonText,
            });
            this.setConnectionState("disconnected", {
              code,
              reason: reasonText,
              idle: true,
            });
            return;
          }
          this.scheduleReconnect(new Error(`Connection lost (code: ${code})`));
          return;
        }

        if (this.isDisconnecting) {
          this.setConnectionState("disconnected");
          this.onSessionEnd?.({ text: this.getFullTranscript() });
        } else {
          this.setConnectionState("disconnected", { code, reason: reasonText });
        }
      });
    });

    this.activeConnectPromise = connectPromise.finally(() => {
      if (this.activeConnectPromise === connectPromise) {
        this.activeConnectPromise = null;
      }
    });

    return this.activeConnectPromise;
  }

  handleMessage(data) {
    try {
      const event = JSON.parse(data.toString());

      switch (event.type) {
        case "transcription_session.created": {
          if (this.preconfigured) {
            // Server-side ephemeral token already configured the session;
            // sending an update would strip language and noise-reduction.
            debugLogger.debug("OpenAI Realtime session created (preconfigured)", {
              model: this.model,
            });
            this.isConnected = true;
            this.isConnecting = false;
            this.reconnectAttempts = 0;
            this.resolvePendingConnect();
            this.setConnectionState("connected", {
              reconnected: this.coldStartBuffer.length > 0,
            });
            this.flushBufferedAudio();
          } else {
            debugLogger.debug("OpenAI Realtime session created, sending configuration", {
              model: this.model,
            });
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) break;
            this.ws.send(
              JSON.stringify({
                type: "transcription_session.update",
                session: {
                  input_audio_format: "pcm16",
                  input_audio_transcription: {
                    model: this.model,
                  },
                  turn_detection: {
                    type: "server_vad",
                    threshold: 0.3,
                    silence_duration_ms: 800,
                    prefix_padding_ms: 500,
                  },
                },
              })
            );
          }
          break;
        }

        case "transcription_session.updated": {
          if (this.pendingResolve) {
            this.isConnected = true;
            this.isConnecting = false;
            this.reconnectAttempts = 0;
            debugLogger.debug("OpenAI Realtime session configured", {
              model: this.model,
            });
            this.resolvePendingConnect();
            this.setConnectionState("connected", {
              reconnected: this.coldStartBuffer.length > 0,
            });
            this.flushBufferedAudio();
          }
          break;
        }

        case "conversation.item.input_audio_transcription.delta": {
          const delta = event.delta || "";
          if (delta) {
            this.hasDetectedSpeech = true;
            this.currentPartial += delta;
            this.onPartialTranscript?.(this.currentPartial);
          }
          break;
        }

        case "conversation.item.input_audio_transcription.completed": {
          const transcript = (event.transcript || "").trim();
          if (transcript) {
            this.hasDetectedSpeech = true;
            this.completedSegments.push(transcript);
          }
          this.currentPartial = "";
          this.resetReplayBuffer();
          const speechTimestamp = this.speechStartedAt || Date.now();
          this.speechStartedAt = null;
          if (transcript) {
            const fullText = this.getFullTranscript();
            this.onFinalTranscript?.(fullText, speechTimestamp);
            debugLogger.debug("OpenAI Realtime turn completed", {
              turnText: transcript.slice(0, 100),
              totalLength: fullText.length,
              segments: this.completedSegments.length,
            });
          }
          break;
        }

        case "input_audio_buffer.speech_started":
          this.hasDetectedSpeech = true;
          this.speechStartedAt = Date.now();
          break;
        case "input_audio_buffer.speech_stopped":
        case "input_audio_buffer.committed":
          break;

        case "error": {
          const errCode = event.error?.code;
          const errMsg = event.error?.message || "OpenAI Realtime error";
          const isEmptyBuffer =
            errCode === "input_audio_buffer_commit_empty" ||
            errMsg.includes("buffer too small") ||
            errMsg.includes("commit_empty");
          if (isEmptyBuffer) {
            debugLogger.debug("OpenAI Realtime empty buffer (server VAD already committed)", {
              code: errCode,
            });
          } else {
            debugLogger.error("OpenAI Realtime error event", {
              code: errCode,
              message: errMsg,
            });
            if (!this.hasSentAudioSinceConnect) {
              debugLogger.debug("OpenAI Realtime ignoring idle warmup error", {
                code: errCode,
                message: errMsg,
              });
              try {
                this.ws?.close();
              } catch {}
            } else {
              try {
                this.ws?.close();
              } catch {}
              this.scheduleReconnect(new Error(errMsg));
            }
          }
          break;
        }

        default:
          break;
      }
    } catch (err) {
      debugLogger.error("OpenAI Realtime message parse error", { error: err.message });
    }
  }

  sendAudio(pcmBuffer) {
    this.hasSentAudioSinceConnect = true;
    this.rememberReplayAudio(pcmBuffer);

    if (!this.ws) {
      this.queueBufferedAudio(pcmBuffer);
      return false;
    }

    if (this.ws.readyState !== WebSocket.OPEN) {
      this.queueBufferedAudio(pcmBuffer);
      return false;
    }

    this.flushBufferedAudio();

    const base64Audio = Buffer.from(pcmBuffer).toString("base64");
    this.ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: base64Audio }));
    this.audioBytesSent += pcmBuffer.length;
    return true;
  }

  async disconnect() {
    debugLogger.debug("OpenAI Realtime disconnect", {
      audioBytesSent: this.audioBytesSent,
      segments: this.completedSegments.length,
      textLength: this.getFullTranscript().length,
      readyState: this.ws?.readyState,
    });

    this.isDisconnecting = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearPendingConnect();

    if (!this.ws) {
      this.setConnectionState("disconnected");
      this.isDisconnecting = false;
      return { text: this.getFullTranscript() };
    }

    if (this.ws.readyState === WebSocket.CONNECTING) {
      const result = { text: this.getFullTranscript() };
      this.cleanupSocket(this.ws, { close: true });
      this.ws = null;
      this.setConnectionState("disconnected");
      this.isDisconnecting = false;
      return result;
    }

    if (this.ws.readyState === WebSocket.OPEN) {
      if (this.audioBytesSent > 0 && this.hasDetectedSpeech) {
        const prevOnFinal = this.onFinalTranscript;
        const prevOnError = this.onError;

        await new Promise((resolve) => {
          const tid = setTimeout(() => {
            debugLogger.debug("OpenAI Realtime commit timeout, using accumulated text");
            resolve();
          }, DISCONNECT_TIMEOUT_MS);

          const done = () => {
            clearTimeout(tid);
            this.onFinalTranscript = prevOnFinal;
            this.onError = prevOnError;
            resolve();
          };

          this.onFinalTranscript = (text) => {
            prevOnFinal?.(text);
            done();
          };

          this.onError = (err) => {
            if (
              err?.message?.includes("buffer too small") ||
              err?.message?.includes("commit_empty")
            ) {
              done();
            } else {
              prevOnError?.(err);
            }
          };

          try {
            this.ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          } catch {
            done();
          }
        });
      } else if (this.audioBytesSent > 0) {
        debugLogger.debug("OpenAI Realtime disconnect skipping commit wait for silent session", {
          audioBytesSent: this.audioBytesSent,
          hasDetectedSpeech: this.hasDetectedSpeech,
        });
      }

      this.ws.close();
    }

    const result = { text: this.getFullTranscript() };
    this.cleanup();
    this.isDisconnecting = false;
    this.setConnectionState("disconnected");
    return result;
  }

  cleanup() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    clearTimeout(this.connectionTimeout);
    this.connectionTimeout = null;
    this.cleanupSocket(this.ws, { close: true });
    this.ws = null;
    this.clearPendingConnect();
    this.isConnected = false;
    this.isConnecting = false;
    this.hasSentAudioSinceConnect = false;
    this.hasDetectedSpeech = false;
  }
}

module.exports = OpenAIRealtimeStreaming;
