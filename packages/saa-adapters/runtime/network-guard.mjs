// Preloaded with --import into every analyzer adapter before its own code (ADR-009, Threat Model T-14).
// The Node.js permission model already denies native bindings, child processes, workers and addons, so these
// public entry points are the only way left to open a connection or resolve a name; each one now throws.
// This file imports network modules only to disable them (dependency rule exception in scripts/dependency-rules.mjs).
import dgram from "node:dgram";
import dns from "node:dns";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";

function denied(what) {
  return function deniedNetworkAccess() {
    const error = new Error(`network access is disabled for analyzer adapters (${what})`);
    error.code = "ERR_ACCESS_DENIED";
    throw error;
  };
}

function lock(target, name, what) {
  Object.defineProperty(target, name, { value: denied(what), writable: false, configurable: false, enumerable: true });
}

lock(net.Socket.prototype, "connect", "net.Socket.connect");
lock(net.Server.prototype, "listen", "net.Server.listen");
lock(net, "connect", "net.connect");
lock(net, "createConnection", "net.createConnection");
lock(tls, "connect", "tls.connect");
lock(http, "request", "http.request");
lock(http, "get", "http.get");
lock(https, "request", "https.request");
lock(https, "get", "https.get");
lock(http2, "connect", "http2.connect");
lock(dgram, "createSocket", "dgram.createSocket");
lock(dgram.Socket.prototype, "bind", "dgram.bind");
lock(dgram.Socket.prototype, "send", "dgram.send");
lock(dgram.Socket.prototype, "connect", "dgram.connect");
for (const name of Object.keys(dns)) if (/^(lookup|resolve)/.test(name)) lock(dns, name, `dns.${name}`);
for (const name of Object.keys(dns.promises))
  if (/^(lookup|resolve)/.test(name)) lock(dns.promises, name, `dns.${name}`);
// Resolver methods live on base-class prototypes too, so the whole chain is locked.
for (const start of [dns.Resolver.prototype, dns.promises.Resolver.prototype])
  for (let proto = start; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto))
    for (const name of Object.getOwnPropertyNames(proto))
      if (/^(lookup|resolve|reverse)/.test(name)) lock(proto, name, `dns.Resolver.${name}`);
for (const name of ["fetch", "WebSocket", "EventSource"]) if (name in globalThis) lock(globalThis, name, name);
syncBuiltinESMExports();
