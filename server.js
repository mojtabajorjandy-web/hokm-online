const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, "public")));

// ---------- Simple admin page for approving VIP requests ----------
app.get("/admin", (req, res) => {
  if (req.query.key !== (process.env.ADMIN_KEY || "changeme")) {
    return res.status(403).send("دسترسی غیرمجاز");
  }
  const rowsHtml = pendingVipRequests
    .map(
      (r, i) =>
        `<tr><td>${r.name}</td><td>${r.city || "-"}</td><td>${r.note || "-"}</td><td>${new Date(r.time).toLocaleString("fa-IR")}</td>
        <td><a href="/admin/approve?key=${req.query.key}&idx=${i}">تأیید VIP</a></td></tr>`
    )
    .join("");
  res.send(`<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="UTF-8"><title>مدیریت VIP</title>
    <style>body{font-family:Tahoma;padding:20px;background:#1a1108;color:#f6efe1;}table{width:100%;border-collapse:collapse;}
    td,th{padding:8px;border-bottom:1px solid #444;text-align:right;}a{color:#e0a838;}</style></head>
    <body><h2>درخواست‌های VIP در انتظار (${pendingVipRequests.length})</h2>
    <table><tr><th>نام</th><th>شهر</th><th>توضیح</th><th>زمان</th><th></th></tr>${rowsHtml}</table></body></html>`);
});

app.get("/admin/approve", (req, res) => {
  if (req.query.key !== (process.env.ADMIN_KEY || "changeme")) {
    return res.status(403).send("دسترسی غیرمجاز");
  }
  const idx = parseInt(req.query.idx);
  const reqItem = pendingVipRequests[idx];
  if (reqItem) {
    if (players[reqItem.id]) players[reqItem.id].vip = true;
    const s = io.sockets.sockets.get(reqItem.id);
    if (s) s.emit("vip_approved");
    pendingVipRequests.splice(idx, 1);
  }
  res.redirect("/admin?key=" + req.query.key);
});

// ---------- Game constants ----------
const SUITS = [
  { key: "s", symbol: "♠", name: "پیک" },
  { key: "h", symbol: "♥", name: "دل" },
  { key: "d", symbol: "♦", name: "خشت" },
  { key: "c", symbol: "♣", name: "گشنیز" },
];
const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
const teamOf = (seat) => (seat % 2 === 0 ? "A" : "B");

function buildDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push({ suit: s.key, rank: r });
  return deck;
}
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function sortHand(hand) {
  return [...hand].sort((a, b) => {
    const si = SUITS.findIndex((s) => s.key === a.suit) - SUITS.findIndex((s) => s.key === b.suit);
    return si !== 0 ? si : a.rank - b.rank;
  });
}
function cardsEqual(a, b) {
  return a.suit === b.suit && a.rank === b.rank;
}
function trickLeaderEntry(trick, trump) {
  return trick.reduce((best, t) => {
    const bTrump = best.card.suit === trump;
    const tTrump = t.card.suit === trump;
    if (tTrump && !bTrump) return t;
    if (tTrump === bTrump && t.card.suit === best.card.suit && t.card.rank > best.card.rank) return t;
    return best;
  }, trick[0]);
}
function isLegalMove(seat, card, hands, trick) {
  if (trick.length === 0) return true;
  const lead = trick[0].card.suit;
  if (card.suit === lead) return true;
  const hasLead = hands[seat].some((c) => c.suit === lead);
  return !hasLead;
}

// ---------- Player directory (in-memory; resets on server restart) ----------
const players = {}; // socket.id -> { name, city, avatarColor, wins, losses, vip, tournamentWins }
function colorFromName(name) {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h},60%,42%)`;
}
function broadcastLobby() {
  const list = Object.entries(players)
    .filter(([id]) => {
      const s = io.sockets.sockets.get(id);
      return s && !s.data.roomCode;
    })
    .map(([id, p]) => ({ id, name: p.name, city: p.city }));
  io.to("lobby").emit("online_list", list);
}
const pendingVipRequests = [];

// ---------- Room management ----------
const rooms = {}; // code -> room

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms[code]);
  return code;
}

function newRoom(code, quickMatch, isTournament) {
  return {
    code,
    isQuickMatch: !!quickMatch,
    isTournament: !!isTournament,
    seats: [0, 1, 2, 3].map((i) => (quickMatch ? { id: null, name: "", isBot: false } : { id: null, name: `ربات ${i + 1}`, isBot: true })),
    hands: [[], [], [], []],
    trump: null,
    hakem: 0,
    turn: 0,
    trick: [],
    tricksWon: { A: 0, B: 0 },
    roundScore: { A: 0, B: 0 },
    round: 0,
    phase: "waiting",
    message: quickMatch ? "در حال پیدا کردن حریف..." : "منتظر بازیکنان...",
    chat: [],
    fillTimer: null,
  };
}

function emitState(room) {
  for (const seat of room.seats) {
    if (!seat.id) continue;
    const mySeat = room.seats.indexOf(seat);
    const payload = {
      code: room.code,
      mySeat,
      seats: room.seats.map((s, i) => ({
        name: s.name,
        isBot: s.isBot,
        connected: !!s.id,
        handCount: room.hands[i] ? room.hands[i].length : 0,
        city: s.city || "",
        avatarColor: s.avatarColor || "#7a6650",
        wins: s.id && players[s.id] ? players[s.id].wins : 0,
        losses: s.id && players[s.id] ? players[s.id].losses : 0,
      })),
      hand: room.hands[mySeat] || [],
      trump: room.trump,
      hakem: room.hakem,
      turn: room.turn,
      trick: room.trick,
      tricksWon: room.tricksWon,
      roundScore: room.roundScore,
      round: room.round,
      phase: room.phase,
      message: room.message,
      chat: room.chat,
      isQuickMatch: room.isQuickMatch,
    };
    io.to(seat.id).emit("state", payload);
  }
}

function startRound(room) {
  const deck = shuffle(buildDeck());
  const hands = [[], [], [], []];
  deck.forEach((c, i) => hands[i % 4].push(c));
  for (let i = 0; i < 4; i++) hands[i] = sortHand(hands[i]);
  room.hands = hands;
  room.trump = null;
  room.trick = [];
  room.tricksWon = { A: 0, B: 0 };
  room.round += 1;
  room.phase = "trump-pending";
  const hakemSeat = room.seats[room.hakem];
  room.message = hakemSeat.isBot
    ? `${hakemSeat.name} در حال انتخاب خال حکم است...`
    : `${hakemSeat.name} حاکم این دست است و در حال انتخاب خال حکم است`;
  emitState(room);
  if (hakemSeat.isBot) {
    setTimeout(() => {
      if (room.phase !== "trump-pending") return;
      const hand = room.hands[room.hakem];
      const counts = {};
      hand.forEach((c) => (counts[c.suit] = (counts[c.suit] || 0) + 1));
      let best = SUITS[0].key,
        bestCount = -1;
      SUITS.forEach((s) => {
        if ((counts[s.key] || 0) > bestCount) {
          bestCount = counts[s.key] || 0;
          best = s.key;
        }
      });
      setTrumpAndStart(room, best);
    }, 1300);
  }
}

function setTrumpAndStart(room, suit) {
  room.trump = suit;
  room.phase = "playing";
  room.turn = room.hakem;
  const turnSeat = room.seats[room.turn];
  room.message = `خال حکم مشخص شد — نوبت ${turnSeat.name}`;
  emitState(room);
  maybeScheduleBot(room);
}

function finishRound(room) {
  const winnerTeam = room.tricksWon.A >= 7 ? "A" : "B";
  room.roundScore[winnerTeam] += 1;
  if (room.roundScore[winnerTeam] >= 7) {
    room.phase = "game-end";
    room.message = `تیم ${winnerTeam === "A" ? "۱ (بازیکنان ۱و۳)" : "۲ (بازیکنان ۲و۴)"} برنده‌ی بازی شد! 🎉`;
    room.seats.forEach((s, i) => {
      if (!s.id || !players[s.id]) return;
      if (teamOf(i) === winnerTeam) {
        players[s.id].wins += 1;
        if (room.isTournament) players[s.id].tournamentWins += 1;
      } else {
        players[s.id].losses += 1;
      }
    });
  } else {
    room.phase = "round-end";
    room.message = `تیم ${winnerTeam === "A" ? "۱" : "۲"} این دست را برد (${room.tricksWon.A} بر ${room.tricksWon.B})`;
  }
  emitState(room);
}

function applyPlay(room, seat, card) {
  if (room.phase !== "playing" || room.turn !== seat) return;
  if (!isLegalMove(seat, card, room.hands, room.trick)) return;
  room.hands[seat] = room.hands[seat].filter((c) => !cardsEqual(c, card));
  room.trick.push({ player: seat, card });

  if (room.trick.length < 4) {
    room.turn = (seat + 1) % 4;
    room.message = `نوبت ${room.seats[room.turn].name}`;
    emitState(room);
    maybeScheduleBot(room);
  } else {
    const winnerEntry = trickLeaderEntry(room.trick, room.trump);
    const winner = winnerEntry.player;
    const team = teamOf(winner);
    room.tricksWon[team] += 1;
    room.message = `${room.seats[winner].name} این دست کوچک را برد`;
    emitState(room);
    setTimeout(() => {
      room.trick = [];
      if (room.hands[0].length === 0) {
        finishRound(room);
      } else {
        room.turn = winner;
        room.message = `نوبت ${room.seats[room.turn].name}`;
        emitState(room);
        maybeScheduleBot(room);
      }
    }, 1500);
  }
}

function botChooseCard(room, seat) {
  const hand = room.hands[seat];
  const legal = hand.filter((c) => isLegalMove(seat, c, room.hands, room.trick));
  let choice;
  if (room.trick.length === 0) {
    const nonTrump = legal.filter((c) => c.suit !== room.trump);
    const pool = nonTrump.length ? nonTrump : legal;
    choice = pool.reduce((a, b) => (a.rank < b.rank ? a : b));
  } else {
    const lead = room.trick[0].card.suit;
    const sameSuit = legal.filter((c) => c.suit === lead);
    const leader = trickLeaderEntry(room.trick, room.trump);
    if (sameSuit.length) {
      const beaters = leader.card.suit === lead ? sameSuit.filter((c) => c.rank > leader.card.rank) : sameSuit;
      choice = (beaters.length ? beaters : sameSuit).reduce((a, b) => (a.rank < b.rank ? a : b));
    } else {
      const trumps = legal.filter((c) => c.suit === room.trump);
      const alreadyTrumped = leader.card.suit === room.trump;
      const usable = alreadyTrumped ? trumps.filter((c) => c.rank > leader.card.rank) : trumps;
      if (usable.length) {
        choice = usable.reduce((a, b) => (a.rank < b.rank ? a : b));
      } else {
        const nonTrumpLegal = legal.filter((c) => c.suit !== room.trump);
        choice = (nonTrumpLegal.length ? nonTrumpLegal : legal).reduce((a, b) => (a.rank < b.rank ? a : b));
      }
    }
  }
  return choice;
}

function maybeScheduleBot(room) {
  if (room.phase !== "playing") return;
  const seat = room.seats[room.turn];
  if (!seat.isBot) return;
  setTimeout(() => {
    if (room.phase !== "playing") return;
    const card = botChooseCard(room, room.turn);
    applyPlay(room, room.turn, card);
  }, 850);
}

function allSeatsReady(room) {
  return room.seats.every((s) => s.id || s.isBot);
}

// ---------- Quick match ----------
let quickMatchRoomCode = null;
let tournamentRoomCode = null;

function scheduleQuickFill(room) {
  if (room.fillTimer) clearTimeout(room.fillTimer);
  room.fillTimer = setTimeout(() => {
    if (room.phase !== "waiting") return;
    room.seats.forEach((s, i) => {
      if (!s.id) room.seats[i] = { id: null, name: `ربات ${i + 1}`, isBot: true };
    });
    if (quickMatchRoomCode === room.code) quickMatchRoomCode = null;
    room.roundScore = { A: 0, B: 0 };
    room.hakem = 0;
    room.round = 0;
    startRound(room);
  }, 12000);
}

// ---------- Socket handlers ----------
io.on("connection", (socket) => {
  let joinedCode = null;

  socket.on("create_room", ({ name }) => {
    const code = makeRoomCode();
    rooms[code] = newRoom(code);
    joinRoomSeat(rooms[code], socket, name);
  });

  socket.on("join_room", ({ code, name }) => {
    const room = rooms[(code || "").toUpperCase()];
    if (!room) {
      socket.emit("error_msg", "اتاقی با این کد پیدا نشد");
      return;
    }
    joinRoomSeat(room, socket, name);
  });

  function joinRoomSeat(room, socket, name) {
    const emptyIdx = room.seats.findIndex((s) => !s.id);
    if (emptyIdx === -1) {
      socket.emit("error_msg", "این اتاق پر است");
      return;
    }
    const profile = players[socket.id] || {};
    const finalName = name || profile.name || `بازیکن ${emptyIdx + 1}`;
    room.seats[emptyIdx] = {
      id: socket.id,
      name: finalName,
      isBot: false,
      city: profile.city || "",
      avatarColor: profile.avatarColor || colorFromName(finalName),
    };
    joinedCode = room.code;
    socket.join(room.code);
    socket.leave("lobby");
    socket.data.roomCode = room.code;
    room.message = room.phase === "waiting" ? "منتظر بازیکنان..." : room.message;
    emitState(room);
    broadcastLobby();
  }

  socket.on("list_online", () => {
    broadcastLobby();
  });

  socket.on("set_profile", ({ name, city }) => {
    const cleanName = String(name || "بازیکن").slice(0, 16).trim() || "بازیکن";
    const cleanCity = String(city || "").slice(0, 20).trim();
    players[socket.id] = {
      name: cleanName,
      city: cleanCity,
      avatarColor: colorFromName(cleanName),
      wins: (players[socket.id] && players[socket.id].wins) || 0,
      losses: (players[socket.id] && players[socket.id].losses) || 0,
      vip: (players[socket.id] && players[socket.id].vip) || false,
      tournamentWins: (players[socket.id] && players[socket.id].tournamentWins) || 0,
    };
    socket.join("lobby");
    socket.emit("profile_ack", players[socket.id]);
    broadcastLobby();
  });

  socket.on("invite_player", ({ targetId }) => {
    const me = players[socket.id];
    if (!me) return;
    const targetSocket = io.sockets.sockets.get(targetId);
    if (!targetSocket || !players[targetId]) {
      socket.emit("error_msg", "این بازیکن دیگر آنلاین نیست");
      return;
    }
    const code = makeRoomCode();
    const room = newRoom(code, false, false);
    rooms[code] = room;
    joinRoomSeat(room, socket, me.name);
    targetSocket.emit("invite_received", { code, fromName: me.name });
  });

  socket.on("accept_invite", ({ code }) => {
    const room = rooms[(code || "").toUpperCase()];
    if (!room) {
      socket.emit("error_msg", "این دعوت دیگر معتبر نیست");
      return;
    }
    const me = players[socket.id];
    joinRoomSeat(room, socket, me ? me.name : undefined);
  });

  socket.on("get_payment_info", () => {
    socket.emit("payment_info", {
      cardNumber: process.env.BANK_CARD_NUMBER || "---- ---- ---- ----",
      cardName: process.env.BANK_CARD_NAME || "Mojtaba Jorjandy",
      usdt: process.env.USDT_WALLET_ADDRESS || "",
    });
  });

  socket.on("vip_purchase_request", ({ note }) => {
    const me = players[socket.id];
    if (!me) return;
    pendingVipRequests.push({ id: socket.id, name: me.name, city: me.city, note: String(note || "").slice(0, 200), time: Date.now() });
    console.log(`VIP REQUEST — name: ${me.name}, socket: ${socket.id}, note: ${note}`);
    socket.emit("vip_request_ack");
  });

  socket.on("get_leaderboard", () => {
    const top = Object.values(players)
      .filter((p) => p.tournamentWins > 0)
      .sort((a, b) => b.tournamentWins - a.tournamentWins)
      .slice(0, 10)
      .map((p) => ({ name: p.name, city: p.city, wins: p.tournamentWins }));
    socket.emit("leaderboard", top);
  });

  socket.on("join_tournament", () => {
    const me = players[socket.id];
    if (!me) return;
    if (!me.vip) {
      socket.emit("error_msg", "برای ورود به تورنومنت باید اشتراک VIP بخری");
      return;
    }
    let room = tournamentRoomCode ? rooms[tournamentRoomCode] : null;
    const hasSlot = room && room.phase === "waiting" && room.seats.some((s) => !s.id);
    if (!hasSlot) {
      const code = makeRoomCode();
      room = newRoom(code, true, true);
      rooms[code] = room;
      tournamentRoomCode = code;
    }
    joinRoomSeat(room, socket, me.name);
    const filled = room.seats.filter((s) => s.id).length;
    if (filled >= 4) {
      if (room.fillTimer) clearTimeout(room.fillTimer);
      if (tournamentRoomCode === room.code) tournamentRoomCode = null;
      room.roundScore = { A: 0, B: 0 };
      room.hakem = 0;
      room.round = 0;
      startRound(room);
    } else {
      room.message = `در حال پیدا کردن حریف تورنومنت... (${filled}/4)`;
      scheduleQuickFill(room);
      emitState(room);
    }
  });

  socket.on("quick_match", ({ name }) => {
    let room = quickMatchRoomCode ? rooms[quickMatchRoomCode] : null;
    const hasSlot = room && room.phase === "waiting" && room.seats.some((s) => !s.id);
    if (!hasSlot) {
      const code = makeRoomCode();
      room = newRoom(code, true);
      rooms[code] = room;
      quickMatchRoomCode = code;
    }
    joinRoomSeat(room, socket, name);
    const filled = room.seats.filter((s) => s.id).length;
    if (filled >= 4) {
      if (room.fillTimer) clearTimeout(room.fillTimer);
      if (quickMatchRoomCode === room.code) quickMatchRoomCode = null;
      room.roundScore = { A: 0, B: 0 };
      room.hakem = 0;
      room.round = 0;
      startRound(room);
    } else {
      room.message = `در حال پیدا کردن حریف... (${filled}/4)`;
      scheduleQuickFill(room);
      emitState(room);
    }
  });

  socket.on("send_chat", ({ text }) => {
    const room = rooms[socket.data.roomCode];
    if (!room) return;
    const seat = room.seats.findIndex((s) => s.id === socket.id);
    if (seat === -1) return;
    const clean = String(text || "").slice(0, 300).trim();
    if (!clean) return;
    const msg = { seat, name: room.seats[seat].name, text: clean, time: Date.now() };
    room.chat.push(msg);
    if (room.chat.length > 100) room.chat.shift();
    io.to(room.code).emit("chat_message", msg);
  });

  socket.on("fill_bots", () => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.phase !== "waiting") return;
    room.seats.forEach((s, i) => {
      if (!s.id) room.seats[i] = { id: null, name: `ربات ${i + 1}`, isBot: true };
    });
    emitState(room);
  });

  socket.on("start_game", () => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.phase !== "waiting") return;
    if (!allSeatsReady(room)) return;
    if (room.fillTimer) clearTimeout(room.fillTimer);
    if (quickMatchRoomCode === room.code) quickMatchRoomCode = null;
    room.roundScore = { A: 0, B: 0 };
    room.hakem = 0;
    room.round = 0;
    startRound(room);
  });

  socket.on("choose_trump", ({ suit }) => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.phase !== "trump-pending") return;
    const seat = room.seats.findIndex((s) => s.id === socket.id);
    if (seat !== room.hakem) return;
    if (!SUITS.some((s) => s.key === suit)) return;
    setTrumpAndStart(room, suit);
  });

  socket.on("play_card", ({ card }) => {
    const room = rooms[socket.data.roomCode];
    if (!room) return;
    const seat = room.seats.findIndex((s) => s.id === socket.id);
    if (seat === -1) return;
    applyPlay(room, seat, card);
  });

  socket.on("next_round", () => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.phase !== "round-end") return;
    room.hakem = (room.hakem + 1) % 4;
    startRound(room);
  });

  socket.on("new_game", () => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.phase !== "game-end") return;
    room.roundScore = { A: 0, B: 0 };
    room.hakem = 0;
    room.round = 0;
    startRound(room);
  });

  socket.on("disconnect", () => {
    delete players[socket.id];
    broadcastLobby();
    const room = rooms[socket.data.roomCode];
    if (!room) return;
    const seatIdx = room.seats.findIndex((s) => s.id === socket.id);
    if (seatIdx === -1) return;
    if (room.phase === "waiting") {
      room.seats[seatIdx] = { id: null, name: `ربات ${seatIdx + 1}`, isBot: true };
    } else {
      room.seats[seatIdx] = { id: null, name: `${room.seats[seatIdx].name} (ربات جایگزین)`, isBot: true };
      if (room.phase === "trump-pending" && room.hakem === seatIdx) {
        const hand = room.hands[seatIdx];
        const counts = {};
        hand.forEach((c) => (counts[c.suit] = (counts[c.suit] || 0) + 1));
        let best = SUITS[0].key,
          bestCount = -1;
        SUITS.forEach((s) => {
          if ((counts[s.key] || 0) > bestCount) {
            bestCount = counts[s.key] || 0;
            best = s.key;
          }
        });
        setTrumpAndStart(room, best);
        return;
      }
      if (room.phase === "playing" && room.turn === seatIdx) {
        maybeScheduleBot(room);
      }
    }
    emitState(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Hokm server running on port ${PORT}`));
