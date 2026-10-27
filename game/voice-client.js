(() => {
  let pc = null, stream = null, seq = 0, polling = null, active = false, room = '', token = '', caller = false, onState = () => {};
  const signal = async (type, data = null) => {
    const r = await fetch('/api/voice/signal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room, token, type, data }) });
    if (!r.ok) throw Error('voice_signal');
    return r.json();
  };
  function stop(notifyServer = true) {
    if (!active) return;
    clearInterval(polling); polling = null;
    stream?.getTracks().forEach(track => track.stop()); stream = null;
    pc?.close(); pc = null; active = false;
    if (notifyServer) signal('leave').catch(() => {});
    onState({ active: false, muted: false, remoteEnded: !notifyServer });
  }
  async function poll() {
    try {
      const r = await fetch(`/api/voice/signal?room=${encodeURIComponent(room)}&token=${encodeURIComponent(token)}&after=${seq}`);
      const j = await r.json();
      if (!j.ok) { stop(false); return; }
      if (!pc) return;
      seq = j.seq;
      for (const m of j.messages) {
        if (m.type === 'offer') {
          await pc.setRemoteDescription(m.data);
          const answer = await pc.createAnswer(); await pc.setLocalDescription(answer); await signal('answer', pc.localDescription);
        } else if (m.type === 'answer') await pc.setRemoteDescription(m.data);
        else if (m.type === 'ice' && m.data) try { await pc.addIceCandidate(m.data); } catch {}
      }
    } catch {}
  }
  async function start(url, callback = () => {}) {
    if (active) return true;
    const u = new URL(url, location.href); room = u.searchParams.get('room') || ''; token = u.searchParams.get('token') || ''; caller = u.searchParams.get('caller') === '1'; onState = callback;
    if (!room || !token) throw Error('voice_room_invalid');
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    pc = new RTCPeerConnection({ iceServers: [] }); stream.getTracks().forEach(track => pc.addTrack(track, stream));
    pc.ontrack = event => { let audio = document.getElementById('gameRemoteVoice'); if (!audio) { audio = document.createElement('audio'); audio.id = 'gameRemoteVoice'; audio.autoplay = true; audio.style.display = 'none'; document.body.appendChild(audio); } audio.srcObject = event.streams[0]; };
    pc.onicecandidate = event => { if (event.candidate) signal('ice', event.candidate).catch(() => {}); };
    active = true; onState({ active: true, muted: false }); polling = setInterval(poll, 700); await signal('ready');
    if (caller) { const offer = await pc.createOffer(); await pc.setLocalDescription(offer); await signal('offer', pc.localDescription); }
    return true;
  }
  function mute() { const track = stream?.getAudioTracks()[0]; if (!track) return false; track.enabled = !track.enabled; onState({ active, muted: !track.enabled }); return !track.enabled; }
  function end() { stop(true); }
  window.ManoGameVoice = { start, mute, end, get active() { return active; } };
})();
