import{createRequire}from'node:module';import{appendFileSync,existsSync,writeFileSync}from'node:fs';const req=createRequire("/workspace/rs-sdk-bot/vendor/rs-sdk/server/engine/package.json");const {WebSocketServer}=req('ws');const observer=(function installAuthObserver(Server, write = (line) => console.log(line), now = Date.now) {
  const original = Server.prototype.emit, seen = new WeakSet;
  let connections = 0, count = 0, overflow = !1, healthy = !0, sealed = !1;
  const log = (kind, row) => {
    if (sealed) {
      healthy = !1;
      kind = "AUTH_ERROR";
      row = { code: "after-seal" };
    }
    try {
      if (count++ < 8192 || kind === "AUTH_SEALED")
        write(kind + " " + JSON.stringify({ at: now(), ...row }));
      else if (!overflow) {
        overflow = !0;
        healthy = !1;
        write("AUTH_ERROR " + JSON.stringify({ at: now(), code: "record-limit" }));
      }
    } catch {
      healthy = !1;
    }
  }, id = (v) => typeof v === "string" && /^[a-zA-Z0-9_-]{1,96}$/.test(v) || typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  Server.prototype.emit = function(event, ...args) {
    if (event === "connection" && args[0] && !seen.has(args[0])) {
      const socket = args[0];
      seen.add(socket);
      const connection = ++connections;
      log("AUTH_CONNECTION", { connection });
      try {
        const { emit, send } = socket;
        if (typeof emit !== "function" || typeof send !== "function")
          throw Error();
        socket.emit = function(event, ...values) {
          if (event === "message")
            try {
              const m = JSON.parse(String(values[0]));
              if (!m || typeof m !== "object")
                throw Error();
              if (m.type === "player_login" || m.type === "player_logout" || m.replyTo !== void 0) {
                if (!id(m.replyTo) || !["player_login", "player_logout"].includes(m.type) || typeof m.username !== "string" || !/^[a-zA-Z0-9]{1,12}$/.test(m.username))
                  throw Error();
                log("AUTH_REQUEST", { connection, replyTo: m.replyTo, type: m.type, account: m.username.toLowerCase() });
              }
            } catch {
              log("AUTH_ERROR", { connection, code: "request-shape" });
            }
          return Reflect.apply(emit, this, [event, ...values]);
        };
        socket.send = function(...values) {
          try {
            const r = JSON.parse(String(values[0]));
            if (!r || !id(r.replyTo) || !Number.isInteger(r.response))
              throw Error();
            log("AUTH_REPLY", { connection, replyTo: r.replyTo, response: r.response });
          } catch {
            log("AUTH_ERROR", { connection, code: "reply-shape" });
          }
          return Reflect.apply(send, this, values);
        };
      } catch {
        log("AUTH_ERROR", { connection, code: "install" });
      }
    }
    return Reflect.apply(original, this, [event, ...args]);
  };
  log("AUTH_READY", { schema: 1 });
  return { seal() {
    log("AUTH_SEALED", { records: count, healthy });
    sealed = !0;
  } };
})(WebSocketServer,line=>{appendFileSync("/workspace/rs-sdk-bot/.practice/deliveries/session-recovery-only-1794824078033-wZM4kb/auth-observations.log",line+'\n');console.log(line);});const timer=setInterval(()=>{if(existsSync("/workspace/rs-sdk-bot/.practice/deliveries/session-recovery-only-1794824078033-wZM4kb/auth-seal-request")){observer.seal();writeFileSync("/workspace/rs-sdk-bot/.practice/deliveries/session-recovery-only-1794824078033-wZM4kb/auth-sealed",'sealed');clearInterval(timer);}},50);timer.unref();