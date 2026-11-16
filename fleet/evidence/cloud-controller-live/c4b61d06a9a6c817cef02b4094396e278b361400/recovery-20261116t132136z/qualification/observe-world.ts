import{appendFileSync,existsSync,writeFileSync}from'node:fs';const trace="/workspace/rs-sdk-bot/.practice/deliveries/session-recovery-only-1794835300201-BOWKBW/button-observations.log";const timer=setInterval(async()=>{if(!existsSync("/workspace/rs-sdk-bot/.practice/deliveries/session-recovery-only-1794835300201-BOWKBW/button-attach-request"))return;clearInterval(timer);try{const[n,b,d,c,r,w,s]=await Promise.all([import("/workspace/rs-sdk-bot/vendor/rs-sdk/server/engine/src/engine/entity/NetworkPlayer.ts"),import("/workspace/rs-sdk-bot/vendor/rs-sdk/server/engine/src/network/game/client/handler/IfButtonHandler.ts"),import("/workspace/rs-sdk-bot/vendor/rs-sdk/server/engine/src/network/game/client/handler/IdkSaveDesignHandler.ts"),import("/workspace/rs-sdk-bot/vendor/rs-sdk/server/engine/src/cache/config/Component.ts"),import("/workspace/rs-sdk-bot/vendor/rs-sdk/server/engine/src/network/game/client/ClientGameProtRepository.ts"),import("/workspace/rs-sdk-bot/vendor/rs-sdk/server/engine/src/engine/World.ts"),import("/workspace/rs-sdk-bot/vendor/rs-sdk/server/engine/src/server/ws/WSClientSocket.ts")]);(function installButtonObserver(m, write = (line) => console.log(line), now = Date.now) {
  const watch = [27, 86, 93], live = new Set;
  let count = 0, wireCount = 0, decoding = null, button = null;
  const int = (v) => Number.isSafeInteger(v) ? v : null, who = (p) => typeof p?.username === "string" ? p.username.toLowerCase() : null, read = (f) => {
    try {
      return f();
    } catch {
      return null;
    }
  }, row = (kind, value) => kind + " " + JSON.stringify({ tick: read(() => int(m.World.currentTick)), at: read(() => int(now())), ...value }), log = (kind, value) => {
    try {
      if (count++ < 4096)
        write(row(kind, value));
    } catch {}
  }, wire = (kind, value) => {
    try {
      if (wireCount++ < 8192)
        write(row(kind, value));
    } catch {}
  }, S = m.WSClientSocket?.prototype, buffer = S?.buffer;
  if (S && typeof buffer === "function")
    S.buffer = function(...args) {
      const player = read(() => this.player), open = !!player && int(player.modalMain) !== null && int(player.modalMain) !== -1, before = open ? read(() => int(this.available)) : null;
      try {
        return Reflect.apply(buffer, this, args);
      } finally {
        if (open)
          wire("BUTTON_WIRE", { account: who(player), length: read(() => int(args[0]?.length)), before, after: read(() => int(this.available)), state: read(() => int(this.state)) });
      }
    };
  const P = m.NetworkPlayer.prototype, decodeIn = P.decodeIn, runScript = P.runScript, getDecoder = m.Repository.getDecoder, ifHandle = m.IfButtonHandler.prototype.handle, idkHandle = m.IdkSaveDesignHandler.prototype.handle;
  P.decodeIn = function(...args) {
    const before = read(() => int(this.client?.available)), prev = decoding, own = { packets: [] };
    decoding = own;
    try {
      return Reflect.apply(decodeIn, this, args);
    } finally {
      decoding = prev;
      const account = who(this);
      if (account && !live.has(account)) {
        live.add(account);
        log("BUTTON_LIVE", { account });
      }
      if (own.packets.some((o) => watch.includes(o)) || int(this.modalMain) !== -1 && !!before)
        log("BUTTON_DECODE", {
          account,
          before,
          after: read(() => int(this.client?.available)),
          packets: own.packets.slice(0, 32),
          modalMain: int(this.modalMain),
          limits: [int(this.userLimit), int(this.clientLimit), int(this.restrictedLimit)]
        });
      else if (account && int(this.modalMain) !== null && int(this.modalMain) !== -1)
        wire("BUTTON_POLL", { account, before, modalMain: int(this.modalMain) });
    }
  };
  m.Repository.getDecoder = function(...args) {
    if (decoding)
      read(() => decoding.packets.push(int(args[0]?.id) ?? -1));
    return Reflect.apply(getDecoder, this, args);
  };
  P.runScript = function(...args) {
    const pre = button ? { protect: this.protect === !0, delayed: this.delayed === !0 } : null, state = Reflect.apply(runScript, this, args);
    if (button && button.runs.length < 4)
      button.runs.push({ script: read(() => typeof args[0]?.script?.name === "string" ? args[0].script.name : null), protectRequested: args[1] === !0, force: args[2] === !0, ...pre, state: int(state) });
    return state;
  };
  m.IfButtonHandler.prototype.handle = function(message, player, ...rest) {
    const com = read(() => m.Component.get(message?.com)), root = com ? read(() => m.Component.get(com.rootLayer)) : null, row = {
      account: who(player),
      com: int(message?.com),
      defined: !!com,
      buttonType: int(com?.buttonType),
      rootLayer: int(com?.rootLayer),
      rootOverlay: typeof root?.overlay === "boolean" ? root.overlay : null,
      visible: com ? read(() => player.isComponentVisible(com) === !0) : null,
      modalMain: int(player?.modalMain),
      modalState: int(player?.modalState),
      protect: player?.protect === !0,
      delayed: player?.delayed === !0,
      busy: read(() => player.busy() === !0),
      resumeButton: read(() => player.resumeButtons.includes(message.com)),
      activeScript: !!player?.activeScript,
      allowDesign: player?.allowDesign === !0
    }, prev = button, own = { runs: [] };
    button = own;
    let result = "threw";
    try {
      result = Reflect.apply(ifHandle, this, [message, player, ...rest]);
      return result;
    } finally {
      button = prev;
      log("BUTTON_HANDLE", { ...row, result: typeof result === "boolean" ? result : "threw", runs: own.runs, modalMainAfter: int(player?.modalMain), modalStateAfter: int(player?.modalState) });
    }
  };
  m.IdkSaveDesignHandler.prototype.handle = function(message, player, ...rest) {
    const allowDesign = player?.allowDesign === !0;
    let result = "threw";
    try {
      result = Reflect.apply(idkHandle, this, [message, player, ...rest]);
      return result;
    } finally {
      log("BUTTON_DESIGN", { account: who(player), allowDesign, gender: int(message?.gender), result: typeof result === "boolean" ? result : "threw", modalMain: int(player?.modalMain) });
    }
  };
  log("BUTTON_READY", { schema: 1, wire: typeof buffer === "function", cwd: read(() => process.cwd()), execPath: read(() => process.execPath) });
})({NetworkPlayer:n.NetworkPlayer,IfButtonHandler:b.default,IdkSaveDesignHandler:d.default,Component:c.default,Repository:r.default,World:w.default,WSClientSocket:s.default},line=>appendFileSync(trace,line+'\n'));writeFileSync("/workspace/rs-sdk-bot/.practice/deliveries/session-recovery-only-1794835300201-BOWKBW/button-attached",'attached');}catch{writeFileSync("/workspace/rs-sdk-bot/.practice/deliveries/session-recovery-only-1794835300201-BOWKBW/button-attached",'failed');}},50);timer.unref();
const locTimer=setInterval(async()=>{if(!existsSync("/workspace/rs-sdk-bot/.practice/deliveries/session-recovery-only-1794835300201-BOWKBW/button-attached"))return;clearInterval(locTimer);try{const[h,l,w]=await Promise.all([import("/workspace/rs-sdk-bot/vendor/rs-sdk/server/engine/src/network/game/client/handler/OpLocHandler.ts"),import("/workspace/rs-sdk-bot/vendor/rs-sdk/server/engine/src/cache/config/LocType.ts"),import("/workspace/rs-sdk-bot/vendor/rs-sdk/server/engine/src/engine/World.ts")]);(function installLocObserver(m, write) {
  const handle = m.OpLocHandler.prototype.handle;
  m.OpLocHandler.prototype.handle = function(message, player) {
    let evidence = null;
    try {
      const loc = m.World.getLoc(message.x, message.z, player.level, message.loc), type = loc ? m.LocType.get(loc.type) : null;
      evidence = { account: player.username, packet: { x: message.x, z: message.z, loc: message.loc, op: message.op }, player: { x: player.x, z: player.z, level: player.level, originX: player.originX, originZ: player.originZ, delayed: player.delayed }, loc: loc ? { type: loc.type, x: loc.x, z: loc.z } : null, options: type?.op ?? null };
    } catch {}
    let result;
    try {
      result = Reflect.apply(handle, this, [message, player]);
      return result;
    } finally {
      try {
        write("LOC_HANDLE " + JSON.stringify({ at: Date.now(), tick: m.World.currentTick, evidence, result }));
      } catch {}
    }
  };
})({OpLocHandler:h.default,LocType:l.default,World:w.default},line=>appendFileSync("/workspace/rs-sdk-bot/.practice/deliveries/session-recovery-only-1794835300201-BOWKBW/loc-observations.log",line+'\n'));appendFileSync("/workspace/rs-sdk-bot/.practice/deliveries/session-recovery-only-1794835300201-BOWKBW/loc-observations.log",'LOC_ATTACHED\n');}catch{appendFileSync("/workspace/rs-sdk-bot/.practice/deliveries/session-recovery-only-1794835300201-BOWKBW/loc-observations.log",'LOC_ATTACH_FAILED\n');}},50);locTimer.unref();