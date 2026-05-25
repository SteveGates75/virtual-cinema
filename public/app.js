/**
 * Virtual Cinema — Frontend Application (v2)
 *
 * Bug fixes in this revision:
 *  [FIX 1] Echo: local-cam has `muted` in HTML. Remote audio is now routed
 *           correctly via a dedicated hidden <audio> element, not forced into
 *           remoteCam.srcObject (which can suppress audio on some browsers).
 *  [FIX 2] Missing mic audio: ontrack now collects ALL incoming tracks into a
 *           single remote MediaStream and attaches it to both the cam video AND
 *           a dedicated audio element. Audio tracks are never silently dropped.
 *  [FIX 3] Screen/file audio mix: attachStreamToStage builds a mixed audio
 *           track via AudioContext (mic + content audio) and replaces the audio
 *           RTCRtpSender, so the partner hears both voice and movie sound.
 *           On stopStream the mic-only audio track is restored.
 *  [NEW]   Fullscreen: stage overlay with enter/exit button + keyboard shortcut F.
 */

'use strict';

// ─── STUN Servers ─────────────────────────────────────────────────────────────
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ],
};

// ─── Quality Presets ──────────────────────────────────────────────────────────
const QUALITY_PRESETS = {
  1080: { width: 1920, height: 1080, frameRate: 30 },
  720:  { width: 1280, height: 720,  frameRate: 30 },
  480:  { width: 854,  height: 480,  frameRate: 24 },
  360:  { width: 640,  height: 360,  frameRate: 24 },
};

// ─── App State ────────────────────────────────────────────────────────────────
const state = {
  userId: null,
  userName: null,
  peerId: null,
  peerName: 'Partner',
  _password: null,

  socket: null,
  pc: null,               // RTCPeerConnection
  localStream: null,      // Camera + mic (getUserMedia)
  screenStream: null,     // Active screen/file stream
  mixedAudioStream: null, // AudioContext mixed stream (mic + content)
  audioCtx: null,         // AudioContext instance (kept alive for mixing)
  isPolite: false,

  // Remote track collection — all incoming tracks land here
  remoteStream: new MediaStream(),

  camEnabled: true,
  micEnabled: true,
  selectedQuality: 720,
  isStreaming: false,
  peerIsStreaming: false,
};

// ─── DOM Refs ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const DOM = {
  loginScreen:     $('login-screen'),
  cinemaScreen:    $('cinema-screen'),
  loginName:       $('login-name'),
  loginPassword:   $('login-password'),
  loginBtn:        $('login-btn'),
  loginError:      $('login-error'),

  connectionBadge: $('connection-badge'),
  roomStatus:      $('room-status'),
  settingsBtn:     $('settings-btn'),
  settingsPanel:   $('settings-panel'),
  leaveBtn:        $('leave-btn'),

  stage:           $('stage'),
  stagePlaceholder:$('stage-placeholder'),
  remoteVideo:     $('remote-video'),
  localStreamPip:  $('local-stream-pip'),
  stageOverlay:    $('stage-overlay'),
  fullscreenBtn:   $('fullscreen-btn'),
  fsEnterIcon:     $('fs-enter-icon'),
  fsExitIcon:      $('fs-exit-icon'),

  screenshareBtn:  $('screenshare-btn'),
  fileBtn:         $('file-btn'),
  fileInput:       $('file-input'),
  stopStreamBtn:   $('stop-stream-btn'),

  localCam:        $('local-cam'),
  remoteCam:       $('remote-cam'),        // Shows partner's video
  remoteAudio:     null,                   // Created dynamically below
  remoteCamLabel:  $('remote-cam-label'),
  remoteCamPlaceholder: $('remote-cam-placeholder'),
  toggleCam:       $('toggle-cam'),
  toggleMic:       $('toggle-mic'),

  chatMessages:    $('chat-messages'),
  chatInput:       $('chat-input'),
  chatSend:        $('chat-send'),
  onlineCount:     $('online-count'),
  toastContainer:  $('toast-container'),
};

// ─── FIX 1 & 2: Dedicated hidden audio element for remote audio ───────────────
// Using a separate <audio> element guarantees audio plays even when the
// browser's autoplay policy restricts <video> or when srcObject is a pure
// video stream. This is the most reliable cross-browser pattern.
(function createRemoteAudioElement() {
  const audio = document.createElement('audio');
  audio.id = 'remote-audio';
  audio.autoplay = true;
  audio.style.display = 'none';
  document.body.appendChild(audio);
  DOM.remoteAudio = audio;
})();

// ─── Utilities ────────────────────────────────────────────────────────────────
function toast(msg, type = 'info', duration = 3500) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  DOM.toastContainer.appendChild(el);
  setTimeout(() => {
    el.style.animation = 'toast-out 0.3s ease forwards';
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, duration);
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function setConnectionBadge(status) {
  const b = DOM.connectionBadge;
  b.className = 'badge';
  const map = {
    online:      ['badge-online',      'Connected'],
    offline:     ['badge-offline',     'Disconnected'],
    connecting:  ['badge-connecting',  'Connecting…'],
  };
  const [cls, label] = map[status] || map.connecting;
  b.classList.add(cls);
  b.textContent = label;
}

// ─── Chat ─────────────────────────────────────────────────────────────────────
function appendMessage({ from, fromId, text, ts, system }) {
  const isOwn = fromId === state.userId;
  const div = document.createElement('div');
  div.className = `chat-msg${isOwn ? ' own' : ''}${system ? ' system' : ''}`;

  if (system) {
    div.innerHTML = `<div class="msg-bubble">${escapeHtml(text)}</div>`;
  } else {
    div.innerHTML = `
      <div class="msg-meta">
        <span class="msg-name">${escapeHtml(from)}</span>
        <span>${formatTime(ts)}</span>
      </div>
      <div class="msg-bubble">${escapeHtml(text)}</div>`;
  }

  DOM.chatMessages.appendChild(div);
  DOM.chatMessages.scrollTop = DOM.chatMessages.scrollHeight;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function sendChat() {
  const text = DOM.chatInput.value.trim();
  if (!text) return;
  state.socket.emit('chat:message', { text });
  DOM.chatInput.value = '';
}

// ─── Media: Local Camera ──────────────────────────────────────────────────────
async function startLocalCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 320 }, height: { ideal: 180 }, frameRate: { ideal: 24 } },
      // FIX 2: explicit audio constraints with echo/noise processing
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });

    state.localStream = stream;
    // FIX 1: local preview is always muted (set in HTML + JS to be safe)
    DOM.localCam.muted = true;
    DOM.localCam.srcObject = stream;

    // Add tracks to peer connection if already connected
    if (state.pc) {
      stream.getTracks().forEach(track => state.pc.addTrack(track, stream));
    }

    toast('Camera ready', 'success', 2000);
  } catch (err) {
    console.warn('[CAM] Permission denied or no camera:', err.message);
    toast('Camera/mic unavailable — audio-only mode', 'info', 4000);
    try {
      const audioStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      state.localStream = audioStream;
      if (state.pc) {
        audioStream.getTracks().forEach(track => state.pc.addTrack(track, audioStream));
      }
    } catch {
      toast('No microphone access either', 'error');
    }
  }
}

// ─── Toggle Camera / Mic ──────────────────────────────────────────────────────
function toggleCam() {
  const track = state.localStream?.getVideoTracks()[0];
  if (!track) return;
  state.camEnabled = !state.camEnabled;
  track.enabled = state.camEnabled;
  DOM.toggleCam.classList.toggle('muted', !state.camEnabled);
  DOM.toggleCam.textContent = state.camEnabled ? '📷' : '🚫';
}

function toggleMic() {
  const track = state.localStream?.getAudioTracks()[0];
  if (!track) return;
  state.micEnabled = !state.micEnabled;
  track.enabled = state.micEnabled;
  DOM.toggleMic.classList.toggle('muted', !state.micEnabled);
  DOM.toggleMic.textContent = state.micEnabled ? '🎤' : '🔇';
}

// ─── FIX 2: WebRTC ontrack — unified remote stream approach ───────────────────
// All incoming tracks land in state.remoteStream (a single persistent
// MediaStream). Video tracks go to remoteCam / remoteVideo. The same
// remoteStream is also attached to the hidden remoteAudio element so audio
// is NEVER dropped regardless of how many tracks arrive or in what order.
function attachRemoteTrack(track) {
  console.log('[TRACK received]', track.kind, track.id);

  // Add to the persistent remote stream
  state.remoteStream.addTrack(track);

  if (track.kind === 'video') {
    if (state.peerIsStreaming) {
      // Peer is screen/file sharing — show in main stage
      DOM.remoteVideo.srcObject = state.remoteStream;
      showStageVideo();
    } else {
      // Regular camera feed
      DOM.remoteCam.srcObject = state.remoteStream;
      DOM.remoteCamPlaceholder.classList.add('hidden');
    }
  }

  // Audio: always pipe full remoteStream into the dedicated audio element.
  // This covers the case where audio arrives before video, after video,
  // or when the video element's browser policy suppresses audio.
  DOM.remoteAudio.srcObject = state.remoteStream;

  track.onunmute = () => console.log('[TRACK unmuted]', track.kind);
  track.onended  = () => {
    console.log('[TRACK ended]', track.kind);
    state.remoteStream.removeTrack(track);
  };
}

// ─── WebRTC Peer Connection ───────────────────────────────────────────────────
function createPeerConnection() {
  if (state.pc) state.pc.close();

  // Reset the remote stream for a fresh connection
  state.remoteStream.getTracks().forEach(t => state.remoteStream.removeTrack(t));

  const pc = new RTCPeerConnection(ICE_SERVERS);
  state.pc = pc;

  // Add all local camera/mic tracks upfront
  if (state.localStream) {
    state.localStream.getTracks().forEach(track => {
      pc.addTrack(track, state.localStream);
      console.log('[LOCAL TRACK added]', track.kind);
    });
  }

  pc.onicecandidate = ({ candidate }) => {
    if (candidate && state.peerId) {
      state.socket.emit('signal:ice', { to: state.peerId, candidate });
    }
  };

  pc.oniceconnectionstatechange = () => {
    console.log('[ICE]', pc.iceConnectionState);
    if (pc.iceConnectionState === 'failed') pc.restartIce();
    if (pc.iceConnectionState === 'disconnected') toast('Connection issue — recovering…', 'error');
    if (['connected', 'completed'].includes(pc.iceConnectionState)) setConnectionBadge('online');
  };

  pc.onconnectionstatechange = () => {
    console.log('[PC]', pc.connectionState);
    if (pc.connectionState === 'failed') toast('WebRTC connection failed. Try refreshing.', 'error', 6000);
  };

  // FIX 2: single ontrack handler that never drops audio
  pc.ontrack = ({ track }) => attachRemoteTrack(track);

  return pc;
}

// ─── Perfect Negotiation ──────────────────────────────────────────────────────
let makingOffer = false;
let ignoreOffer = false;

async function handleNegotiationNeeded() {
  try {
    makingOffer = true;
    await state.pc.setLocalDescription();
    state.socket.emit('signal:offer', { to: state.peerId, offer: state.pc.localDescription });
  } catch (err) {
    console.error('[OFFER]', err);
  } finally {
    makingOffer = false;
  }
}

async function handleIncomingOffer({ from, offer }) {
  if (!state.pc || from !== state.peerId) return;

  const offerCollision = offer.type === 'offer' &&
    (makingOffer || state.pc.signalingState !== 'stable');

  ignoreOffer = !state.isPolite && offerCollision;
  if (ignoreOffer) { console.log('[SIGNAL] Ignoring offer (glare)'); return; }

  try {
    await state.pc.setRemoteDescription(offer);
    if (offer.type === 'offer') {
      await state.pc.setLocalDescription();
      state.socket.emit('signal:answer', { to: from, answer: state.pc.localDescription });
    }
  } catch (err) {
    console.error('[OFFER handle]', err);
  }
}

async function handleIncomingAnswer({ from, answer }) {
  if (!state.pc || from !== state.peerId || ignoreOffer) return;
  try { await state.pc.setRemoteDescription(answer); }
  catch (err) { console.error('[ANSWER]', err); }
}

async function handleIncomingIce({ from, candidate }) {
  if (!state.pc || from !== state.peerId) return;
  try { await state.pc.addIceCandidate(candidate); }
  catch (err) { if (!ignoreOffer) console.error('[ICE]', err); }
}

// ─── FIX 3: Audio Context Mixer ───────────────────────────────────────────────
// Creates a mixed MediaStream audio track combining:
//   - The user's microphone (from localStream)
//   - Content audio (from screen share or video file stream)
// Returns a MediaStream with a single mixed audio track.
function createMixedAudioStream(contentStream) {
  // Lazily create/reuse AudioContext to avoid the "too many contexts" limit
  if (!state.audioCtx || state.audioCtx.state === 'closed') {
    state.audioCtx = new AudioContext();
  }
  const ctx = state.audioCtx;
  const dest = ctx.createMediaStreamDestination();

  // Mic audio
  const micTrack = state.localStream?.getAudioTracks()[0];
  if (micTrack) {
    const micStream = new MediaStream([micTrack]);
    const micSource = ctx.createMediaStreamSource(micStream);
    micSource.connect(dest);
    console.log('[AUDIO MIX] Mic connected');
  }

  // Content audio (screen share / video file)
  const contentAudioTracks = contentStream.getAudioTracks();
  if (contentAudioTracks.length > 0) {
    const contentOnlyStream = new MediaStream(contentAudioTracks);
    const contentSource = ctx.createMediaStreamSource(contentOnlyStream);
    contentSource.connect(dest);
    console.log('[AUDIO MIX] Content audio connected');
  } else {
    console.log('[AUDIO MIX] No content audio track found');
  }

  return dest.stream;
}

// ─── Screen Share ─────────────────────────────────────────────────────────────
async function startScreenShare() {
  const preset = QUALITY_PRESETS[state.selectedQuality];
  try {
    // FIX 3: explicitly request audio: true so tab/system audio is captured
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width:     { ideal: preset.width },
        height:    { ideal: preset.height },
        frameRate: { ideal: preset.frameRate },
        cursor:    'always',
      },
      audio: true,  // request system/tab audio
    });

    await attachStreamToStage(stream, 'screen');

    // Browser "Stop sharing" button fires onended on the video track
    stream.getVideoTracks()[0].addEventListener('ended', () => stopStream(), { once: true });

  } catch (err) {
    if (err.name !== 'NotAllowedError') toast('Screen share failed: ' + err.message, 'error');
  }
}

// ─── Video File Stream ────────────────────────────────────────────────────────
async function startFileStream(file) {
  const url = URL.createObjectURL(file);
  const videoEl = document.createElement('video');
  videoEl.src = url;
  videoEl.autoplay = true;
  // Keep muted=false so captureStream captures audio,
  // but it won't play locally (the element is detached from DOM)
  videoEl.muted = false;

  await new Promise((resolve, reject) => {
    videoEl.onloadedmetadata = resolve;
    videoEl.onerror = reject;
  });

  videoEl.play().catch(() => {});

  const stream = videoEl.captureStream
    ? videoEl.captureStream()
    : videoEl.mozCaptureStream
      ? videoEl.mozCaptureStream()
      : null;

  if (!stream) {
    toast('captureStream not supported in this browser', 'error');
    URL.revokeObjectURL(url);
    return;
  }

  await attachStreamToStage(stream, 'file');
  toast(`Streaming: ${file.name}`, 'success');

  state._fileVideoEl = videoEl;
  state._fileUrl = url;
}

// ─── Attach Stream to Stage + Peer ───────────────────────────────────────────
async function attachStreamToStage(stream, type) {
  state.screenStream = stream;
  state.isStreaming = true;

  // Local PiP preview (streamer sees what they're sharing)
  DOM.localStreamPip.srcObject = stream;
  DOM.localStreamPip.classList.remove('hidden');

  // UI state
  DOM.stopStreamBtn.classList.remove('hidden');
  DOM.screenshareBtn.classList.add('hidden');
  DOM.fileBtn.classList.add('hidden');

  // Notify peer so they know to show the stage video
  state.socket.emit('stream:start', { type });

  if (!state.pc || !state.peerId) return;

  const senders = state.pc.getSenders();

  // ── Replace video track ──────────────────────────────────────────────────
  const newVideoTrack = stream.getVideoTracks()[0];
  if (newVideoTrack) {
    const videoSender = senders.find(s => s.track?.kind === 'video');
    if (videoSender) {
      await videoSender.replaceTrack(newVideoTrack).catch(console.error);
      console.log('[STREAM] Video track replaced');
    } else {
      state.pc.addTrack(newVideoTrack, stream);
      console.log('[STREAM] Video track added (no prior sender)');
    }
  }

  // ── FIX 3: Replace audio track with mic+content mix ──────────────────────
  const mixedStream = createMixedAudioStream(stream);
  state.mixedAudioStream = mixedStream;

  const mixedAudioTrack = mixedStream.getAudioTracks()[0];
  if (mixedAudioTrack) {
    const audioSender = senders.find(s => s.track?.kind === 'audio');
    if (audioSender) {
      await audioSender.replaceTrack(mixedAudioTrack).catch(console.error);
      console.log('[STREAM] Mixed audio track replaced in sender');
    } else {
      state.pc.addTrack(mixedAudioTrack, mixedStream);
      console.log('[STREAM] Mixed audio track added (no prior sender)');
    }
  }
}

// ─── Stop Stream ──────────────────────────────────────────────────────────────
function stopStream() {
  if (!state.isStreaming) return;

  if (state.screenStream) {
    state.screenStream.getTracks().forEach(t => t.stop());
    state.screenStream = null;
  }

  if (state._fileVideoEl) {
    state._fileVideoEl.pause();
    state._fileVideoEl.src = '';
    state._fileVideoEl = null;
  }

  if (state._fileUrl) {
    URL.revokeObjectURL(state._fileUrl);
    state._fileUrl = null;
  }

  // Don't close audioCtx — keep it alive for potential future mixes
  state.mixedAudioStream = null;
  state.isStreaming = false;

  DOM.localStreamPip.srcObject = null;
  DOM.localStreamPip.classList.add('hidden');
  DOM.stopStreamBtn.classList.add('hidden');
  DOM.screenshareBtn.classList.remove('hidden');
  DOM.fileBtn.classList.remove('hidden');

  hideStageVideo();
  state.socket.emit('stream:stop');
  toast('Stream stopped', 'info', 2000);

  // FIX 3: Restore original camera video + mic-only audio tracks
  if (state.pc && state.localStream) {
    const senders = state.pc.getSenders();

    const camVideoTrack = state.localStream.getVideoTracks()[0];
    if (camVideoTrack) {
      const vs = senders.find(s => s.track?.kind === 'video');
      if (vs) vs.replaceTrack(camVideoTrack).catch(console.error);
    }

    const micAudioTrack = state.localStream.getAudioTracks()[0];
    if (micAudioTrack) {
      const as = senders.find(s => s.track?.kind === 'audio');
      if (as) as.replaceTrack(micAudioTrack).catch(console.error);
    }
  }
}

// ─── Stage Video Visibility ───────────────────────────────────────────────────
function showStageVideo() {
  DOM.stagePlaceholder.classList.add('hidden');
  DOM.remoteVideo.classList.remove('hidden');
  DOM.stageOverlay.classList.remove('hidden');
}

function hideStageVideo() {
  DOM.remoteVideo.classList.add('hidden');
  DOM.remoteVideo.srcObject = null;
  DOM.stagePlaceholder.classList.remove('hidden');
  DOM.stageOverlay.classList.add('hidden');
  // Exit fullscreen if active
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

// ─── NEW: Fullscreen API ──────────────────────────────────────────────────────
function toggleFullscreen() {
  if (!document.fullscreenElement) {
    // Enter fullscreen on the stage element so the video + overlay fill screen
    DOM.stage.requestFullscreen({ navigationUI: 'hide' }).catch(err => {
      toast('Fullscreen unavailable: ' + err.message, 'error');
    });
  } else {
    document.exitFullscreen().catch(() => {});
  }
}

function onFullscreenChange() {
  const isFs = !!document.fullscreenElement;
  DOM.fsEnterIcon.classList.toggle('hidden', isFs);
  DOM.fsExitIcon.classList.toggle('hidden', !isFs);
  DOM.stage.classList.toggle('fullscreen-active', isFs);
}

// ─── Quality Settings ─────────────────────────────────────────────────────────
function initQualityButtons() {
  document.querySelectorAll('.quality-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.quality-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.selectedQuality = parseInt(btn.dataset.res);
      toast(`Quality set to ${btn.dataset.res}p`, 'info', 2000);
    });
  });
}

// ─── Socket.io ────────────────────────────────────────────────────────────────
function initSocket() {
  const socket = io({ reconnectionDelay: 2000, reconnectionDelayMax: 10000 });
  state.socket = socket;

  socket.on('connect', () => {
    console.log('[SOCKET] Connected:', socket.id);
    setConnectionBadge('connecting');
  });

  socket.on('disconnect', reason => {
    console.log('[SOCKET] Disconnected:', reason);
    setConnectionBadge('offline');
    toast('Disconnected. Reconnecting…', 'error');
  });

  socket.on('reconnect', () => {
    toast('Reconnected!', 'success');
    socket.emit('auth', { password: state._password, name: state.userName });
  });

  socket.on('auth:ok', ({ userId, userName, history, peers }) => {
    state.userId = userId;
    state.userName = userName;
    setConnectionBadge('online');

    DOM.loginScreen.classList.remove('active');
    DOM.cinemaScreen.classList.add('active');

    history.forEach(msg => appendMessage(msg));

    if (peers.length > 0) {
      const peer = peers[0];
      state.peerId = peer.id;
      state.peerName = peer.name;
      state.isPolite = false; // late joiner = impolite (doesn't defer)
      DOM.remoteCamLabel.textContent = peer.name;
      DOM.roomStatus.textContent = `Watching with ${peer.name}`;
      updateOnlineCount(2);
      appendMessage({ system: true, text: `${peer.name} is already in the room.`, ts: Date.now() });
      initCall();
    }
  });

  socket.on('auth:fail', ({ message }) => {
    DOM.loginError.textContent = message;
    DOM.loginError.classList.remove('hidden');
    DOM.loginBtn.disabled = false;
    DOM.loginBtn.textContent = 'Enter Room';
  });

  socket.on('peer:joined', ({ id, name }) => {
    state.peerId = id;
    state.peerName = name;
    state.isPolite = true; // first in room = polite (defers on glare)
    DOM.remoteCamLabel.textContent = name;
    DOM.roomStatus.textContent = `Watching with ${name}`;
    updateOnlineCount(2);
    appendMessage({ system: true, text: `${name} joined the room.`, ts: Date.now() });
    toast(`${name} joined! 🎬`, 'success');
    initCall();
  });

  socket.on('peer:left', ({ id, name }) => {
    if (id !== state.peerId) return;
    state.peerId = null;
    DOM.remoteCamLabel.textContent = 'Partner';
    DOM.remoteCamPlaceholder.classList.remove('hidden');
    DOM.remoteCam.srcObject = null;
    DOM.remoteAudio.srcObject = null;
    DOM.roomStatus.textContent = 'Waiting for partner…';
    updateOnlineCount(1);
    hideStageVideo();
    state.peerIsStreaming = false;
    // Reset remote stream for next connection
    state.remoteStream.getTracks().forEach(t => state.remoteStream.removeTrack(t));
    appendMessage({ system: true, text: `${name} left the room.`, ts: Date.now() });
    toast(`${name} left`, 'info');
  });

  socket.on('chat:message', msg => appendMessage(msg));

  socket.on('signal:offer',  data => handleIncomingOffer(data));
  socket.on('signal:answer', data => handleIncomingAnswer(data));
  socket.on('signal:ice',    data => handleIncomingIce(data));

  socket.on('stream:start', ({ from, type }) => {
    if (from !== state.peerId) return;
    state.peerIsStreaming = true;
    // The stage video will show when the video track arrives via ontrack
    toast(`${state.peerName} started streaming (${type})`, 'info');
  });

  socket.on('stream:stop', ({ from }) => {
    if (from !== state.peerId) return;
    state.peerIsStreaming = false;
    hideStageVideo();
    toast(`${state.peerName} stopped streaming`, 'info', 2000);
  });
}

// ─── Init Call ────────────────────────────────────────────────────────────────
function initCall() {
  const pc = createPeerConnection();
  pc.onnegotiationneeded = handleNegotiationNeeded;
  toast('Establishing video call…', 'info', 2500);
}

// ─── Online Count ─────────────────────────────────────────────────────────────
function updateOnlineCount(n) {
  DOM.onlineCount.textContent = `${n} online`;
}

// ─── Login ────────────────────────────────────────────────────────────────────
function initLogin() {
  async function doLogin() {
    const name = DOM.loginName.value.trim() || 'Guest';
    const password = DOM.loginPassword.value;

    if (!password) {
      DOM.loginError.textContent = 'Please enter the room password.';
      DOM.loginError.classList.remove('hidden');
      return;
    }

    DOM.loginBtn.disabled = true;
    DOM.loginBtn.textContent = 'Entering…';
    DOM.loginError.classList.add('hidden');

    state.userName = name;
    state._password = password;

    if (!state.socket) initSocket();
    startLocalCamera(); // parallel — don't await, join room simultaneously

    state.socket.emit('auth', { password, name });
  }

  DOM.loginBtn.addEventListener('click', doLogin);
  DOM.loginPassword.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  DOM.loginName.addEventListener('keydown', e => { if (e.key === 'Enter') DOM.loginPassword.focus(); });
}

// ─── UI Events ────────────────────────────────────────────────────────────────
function initUIEvents() {
  // Settings panel toggle
  DOM.settingsBtn.addEventListener('click', e => {
    e.stopPropagation();
    DOM.settingsPanel.classList.toggle('hidden');
  });
  document.addEventListener('click', () => DOM.settingsPanel.classList.add('hidden'));
  DOM.settingsPanel.addEventListener('click', e => e.stopPropagation());

  // Leave room
  DOM.leaveBtn.addEventListener('click', () => {
    if (!confirm('Leave the cinema room?')) return;
    stopStream();
    if (state.audioCtx) state.audioCtx.close().catch(() => {});
    if (state.pc) state.pc.close();
    if (state.socket) state.socket.disconnect();
    location.reload();
  });

  // Screen share
  DOM.screenshareBtn.addEventListener('click', () => {
    if (!state.peerId) { toast('Wait for your partner to join first', 'info'); return; }
    startScreenShare();
  });

  // Video file
  DOM.fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!state.peerId) { toast('Wait for your partner to join first', 'info'); DOM.fileInput.value = ''; return; }
    await startFileStream(file);
    DOM.fileInput.value = '';
  });

  DOM.stopStreamBtn.addEventListener('click', stopStream);
  DOM.toggleCam.addEventListener('click', toggleCam);
  DOM.toggleMic.addEventListener('click', toggleMic);

  // Chat
  DOM.chatSend.addEventListener('click', sendChat);
  DOM.chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });

  // NEW: Fullscreen button
  DOM.fullscreenBtn.addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', onFullscreenChange);

  // Keyboard shortcut: F to toggle fullscreen when a stream is active
  document.addEventListener('keydown', e => {
    if (e.key === 'f' || e.key === 'F') {
      if (document.activeElement === DOM.chatInput) return; // don't hijack typing
      if (!DOM.remoteVideo.classList.contains('hidden')) toggleFullscreen();
    }
  });

  // Show/hide overlay on stage hover
  DOM.stage.addEventListener('mouseenter', () => {
    if (!DOM.remoteVideo.classList.contains('hidden')) {
      DOM.stageOverlay.classList.remove('hidden');
    }
  });
  DOM.stage.addEventListener('mouseleave', () => {
    if (!document.fullscreenElement) {
      // Keep visible in fullscreen; hide when not
    }
    // Always show the overlay — it auto-hides via CSS opacity on :not(:hover)
  });

  initQualityButtons();
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initLogin();
  initUIEvents();
});
