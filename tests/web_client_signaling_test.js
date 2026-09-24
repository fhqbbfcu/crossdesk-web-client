"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "../web_client.js"), "utf8");
const settle = () => new Promise(setImmediate);

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function createClient() {
  const messages = [];
  const errors = [];
  const peers = [];
  const sockets = [];
  const timers = new Map();
  let now = 0;
  let nextTimer = 0;
  const element = (value = "") => ({
    value, style: {}, dataset: {}, textContent: "",
    addEventListener() {}, setAttribute() {},
  });
  const elements = {
    "transmission-id": element("host-123"),
    "transmission-pwd": element("123456"),
    "connection-feedback": element(),
    connect: element(), disconnect: element(), media: element(),
  };

  class MockSocket extends EventTarget {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = MockSocket.OPEN;
    constructor() { super(); sockets.push(this); }
    send(payload) {
      const message = JSON.parse(payload);
      if (message.type === this.failType) throw new Error("Socket send failed");
      messages.push(message);
    }
    receive(message) {
      const event = new Event("message");
      event.data = JSON.stringify(message);
      this.dispatchEvent(event);
    }
    close() {
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
    }
  }

  class MockPeer extends EventTarget {
    iceGatheringState = "new";
    iceConnectionState = "new";
    localDescription = null;
    localDescriptionCalls = 0;
    constructor() { super(); peers.push(this); }
    async setRemoteDescription(description) { this.remoteDescription = description; }
    async createAnswer() {
      if (this.answerGate) await this.answerGate;
      return { type: "answer", sdp: "answer-without-candidates" };
    }
    async setLocalDescription(description) {
      this.localDescriptionCalls++;
      if (this.localGate) await this.localGate;
      this.localDescription = description;
      this.iceGatheringState = "gathering";
    }
    getSenders() { return []; }
    close() { this.iceConnectionState = "closed"; }
    candidate() {
      this.onicecandidate({ candidate: {
        candidate: "candidate:1 1 UDP 2122260223 192.0.2.1 50000 typ host",
        sdpMid: "0",
      } });
    }
  }

  const window = { CrossDeskControl: { setDataChannel() {} } };
  vm.runInNewContext(source, {
    window,
    document: { getElementById: (id) => elements[id] || null, addEventListener() {} },
    WebSocket: MockSocket,
    RTCPeerConnection: MockPeer,
    console: { warn() {}, error: (...args) => errors.push(args) },
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, deadline: now + delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    setInterval: () => ++nextTimer,
    clearInterval() {},
  });
  const socket = sockets[0];
  socket.dispatchEvent(new Event("open"));
  socket.receive({ type: "login", user_id: "web-123" });
  window.connect();

  return {
    window, socket, peers, messages, errors, elements,
    answers: () => messages.filter(({ type }) => type === "answer"),
    candidates: () => messages.filter(({ type }) => type === "new_candidate_mid"),
    offer() {
      socket.receive({ type: "offer", sdp: "remote-offer" });
      return peers.at(-1);
    },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.deadline <= now && timers.delete(id)) timer.callback();
      }
    },
  };
}

test("sends answer while gathering continues and trickles later candidates", async () => {
  const c = createClient();
  const peer = c.offer();
  await settle();

  assert.equal(peer.iceGatheringState, "gathering");
  assert.deepEqual(c.answers(), [{
    type: "answer", transmission_id: "host-123", user_id: "web-123",
    remote_user_id: "host-123", sdp: "answer-without-candidates",
  }]);
  peer.candidate();
  assert.equal(c.candidates().length, 1);
  assert.equal(c.candidates()[0].mid, "0");

  // A slow/unreachable ICE server must not tear down an established path.
  peer.iceConnectionState = "connected";
  peer.dispatchEvent(new Event("iceconnectionstatechange"));
  c.advance(10001);
  await settle();
  assert.equal(peer.iceConnectionState, "connected");
  assert.equal(c.messages.some(({ type }) => type === "user_leave_transmission"), false);
  assert.deepEqual(c.errors, []);
});

for (const stage of ["answer", "local"]) {
  for (const reconnect of [false, true]) {
    test(`ignores a cancelled ${stage} operation, reconnect=${reconnect}`, async () => {
      const c = createClient();
      const peer = c.offer();
      const gate = deferred();
      peer[`${stage}Gate`] = gate.promise;
      await settle();
      c.window.disconnect();
      if (reconnect) {
        c.elements["transmission-id"].value = "host-456";
        c.window.connect();
        c.offer();
        await settle();
      }

      gate.resolve();
      await settle();
      peer.candidate();
      assert.equal(c.answers().length, reconnect ? 1 : 0);
      if (reconnect) assert.equal(c.answers()[0].transmission_id, "host-456");
      if (stage === "answer") assert.equal(peer.localDescriptionCalls, 0);
      assert.equal(c.candidates().length, 0);
      assert.deepEqual(c.errors, []);
    });
  }
}

test("only the current peer sends an answer or candidates after a replacement offer", async () => {
  const c = createClient();
  const oldPeer = c.offer();
  const gate = deferred();
  oldPeer.localGate = gate.promise;
  await settle();
  const newPeer = c.offer();
  await settle();
  gate.resolve();
  await settle();
  oldPeer.candidate();
  newPeer.candidate();
  assert.equal(c.answers().length, 1);
  assert.equal(c.candidates().length, 1);
});

test("a failed answer send reports failure and closes the peer", async () => {
  const c = createClient();
  c.socket.failType = "answer";
  const peer = c.offer();
  await settle();
  assert.equal(c.answers().length, 0);
  assert.equal(peer.iceConnectionState, "closed");
  assert.match(c.elements["connection-feedback"].textContent, /连接失败/);
  assert.ok(c.errors.some(([message]) => message === "Failed to handle offer"));
});

test("the overall connection deadline still closes a peer that never connects", async () => {
  const c = createClient();
  const peer = c.offer();
  await settle();
  c.advance(20000);
  await settle();
  assert.equal(peer.iceConnectionState, "closed");
  assert.match(c.elements["connection-feedback"].textContent, /连接超时/);
});
