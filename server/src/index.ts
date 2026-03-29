import { WebSocketServer, WebSocket } from "ws";
import type {
  Game,
  Player,
  User,
  WSMessage,
  RegData,
  CreateGameData,
  JoinGameData,
  StartGameData,
  AnswerData,
} from "./types.js";

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

const wss = new WebSocketServer({ port: PORT });
const userData = new Map<WebSocket, string>();
const users = new Map<string, User>();
const games = new Map<string, Game>();

let userIdCounter = 1;
let gameIdCounter = 1;

const generateCode = (): string => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
};

const generateUniqueCode = (): string => {
  let code = generateCode();
  const usedCodes = new Set([...games.values()].map((g) => g.code));
  while (usedCodes.has(code)) {
    code = generateCode();
  }
  return code;
};

const send = (ws: WebSocket, type: string, data: unknown): void => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, data, id: 0 }));
  }
};

const broadcast = (wsList: WebSocket[], type: string, data: unknown): void => {
  const msg = JSON.stringify({ type, data, id: 0 });
  for (const ws of wsList) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
};

const getGamePlayers = (game: Game): WebSocket[] => {
  return game.players
    .filter((p) => p.ws && p.ws.readyState === WebSocket.OPEN)
    .map((p) => p.ws!);
};

const getGameParticipants = (game: Game): WebSocket[] => {
  const sockets: WebSocket[] = getGamePlayers(game);
  const host = [...users.values()].find((u) => u.index === game.hostId);
  if (host?.ws && host.ws.readyState === WebSocket.OPEN) {
    if (!sockets.includes(host.ws)) {
      sockets.push(host.ws);
    }
  }
  return sockets;
};

const broadcastToGame = (game: Game, type: string, data: unknown): void => {
  broadcast(getGameParticipants(game), type, data);
};

const handleLogin = (ws: WebSocket, data: RegData): void => {
  const { name, password } = data;

  const existing = [...users.values()].find((u) => u.name === name);
  if (existing) {
    if (existing.password !== password) {
      send(ws, "reg", {
        name,
        index: "",
        error: true,
        errorText: "Wrong password",
      });
      return;
    }
    existing.ws = ws;
    userData.set(ws, existing.index);
    send(ws, "reg", {
      name: existing.name,
      index: existing.index,
      error: false,
      errorText: "",
    });
    return;
  }

  const index = String(userIdCounter++);
  const user: User = { name, password, index, ws };
  users.set(index, user);
  userData.set(ws, index);

  send(ws, "reg", { name, index, error: false, errorText: "" });
};

const handleCreateGame = (ws: WebSocket, data: CreateGameData): void => {
  const userId = userData.get(ws);

  const gameId = String(gameIdCounter++);
  const code = generateUniqueCode();

  const game: Game = {
    id: gameId,
    code,
    hostId: userId!,
    questions: data.questions,
    players: [],
    currentQuestion: -1,
    status: "waiting",
    playerAnswers: new Map(),
  };

  games.set(gameId, game);

  send(ws, "game_created", { gameId, code });
};

const handleJoinGame = (ws: WebSocket, data: JoinGameData): void => {
  const userId = userData.get(ws);
  const user = users.get(userId!);
  const game = [...games.values()].find(
    (g) => g.code === data.code.toUpperCase(),
  );

  const alreadyIn = game?.players.find((p) => p.index === userId);
  if (!alreadyIn) {
    const player: Player = { name: user!.name, index: userId!, score: 0, ws };
    game!.players.push(player);
  } else {
    alreadyIn.ws = ws;
  }

  send(ws, "game_joined", { gameId: game!.id });

  const playerData = game!.players.map((p) => ({
    name: p.name,
    index: p.index,
    score: p.score,
  }));

  broadcastToGame(game!, "player_joined", {
    playerName: user!.name,
    playerCount: game!.players.length,
  });

  broadcastToGame(game!, "update_players", playerData);
};

const sendQuestion = (game: Game): void => {
  const q = game.questions[game.currentQuestion];
  const participants = getGameParticipants(game);

  broadcast(participants, "question", {
    questionNumber: game.currentQuestion + 1,
    totalQuestions: game.questions.length,
    text: q.text,
    options: q.options,
    timeLimitSec: q.timeLimitSec,
  });

  game.questionStartTime = Date.now();
  game.playerAnswers = new Map();
  for (const p of game.players) {
    p.hasAnswered = false;
    p.answerTime = undefined;
    p.answeredCorrectly = undefined;
  }

  game.questionTimer = setTimeout(() => {
    finishQuestion(game);
  }, q.timeLimitSec * 1000);
};

const finishQuestion = (game: Game): void => {
  if (game.questionTimer) {
    clearTimeout(game.questionTimer);
    game.questionTimer = undefined;
  }

  const qIndex = game.currentQuestion;
  const q = game.questions[qIndex];
  const BASE_POINTS = 1000;

  const playerResults = game.players.map((p) => {
    const answer = game.playerAnswers.get(p.index);
    const answered = !!answer;
    const correct = answered && answer!.answerIndex === q.correctIndex;

    let pointsEarned = 0;
    if (correct) {
      const elapsed = (answer!.timestamp - game.questionStartTime!) / 1000;
      const timeRemaining = Math.max(0, q.timeLimitSec - elapsed);
      pointsEarned = Math.round(BASE_POINTS * (timeRemaining / q.timeLimitSec));
    }

    p.score += pointsEarned;

    return {
      name: p.name,
      answered,
      correct,
      pointsEarned,
      totalScore: p.score,
    };
  });

  broadcastToGame(game, "question_result", {
    questionIndex: qIndex,
    correctIndex: q.correctIndex,
    playerResults,
  });

  const nextIndex = qIndex + 1;
  if (nextIndex >= game.questions.length) {
    game.status = "finished";

    const sorted = [...game.players].sort((a, b) => b.score - a.score);
    const scoreboard = sorted.map((p, i) => ({
      name: p.name,
      score: p.score,
      rank: i + 1,
    }));

    broadcastToGame(game, "game_finished", { scoreboard });
  } else {
    game.currentQuestion = nextIndex;
    setTimeout(() => sendQuestion(game), 3000);
  }
};

const handleStartGame = (ws: WebSocket, data: StartGameData): void => {
  const userId = userData.get(ws);

  const game = games.get(data.gameId);
  if (!game) {
    send(ws, "error", { message: "Game not found" });
    return;
  }

  game!.status = "in_progress";
  game!.currentQuestion = 0;

  sendQuestion(game!);
};

const handleAnswer = (ws: WebSocket, data: AnswerData): void => {
  const userId = userData.get(ws);
  const game = games.get(data.gameId);
  game!.playerAnswers.set(userId!, {
    answerIndex: data.answerIndex,
    timestamp: Date.now(),
  });

  const player = game!.players.find((p) => p.index === userId);
  if (player) {
    player.hasAnswered = true;
  }

  send(ws, "answer_accepted", { questionIndex: data.questionIndex });

  const allAnswered = game!.players.every((p) =>
    game!.playerAnswers.has(p.index),
  );
  if (allAnswered && game!.players.length > 0) {
    finishQuestion(game!);
  }
};

const handleDisconnect = (ws: WebSocket): void => {
  const userId = userData.get(ws);
  if (!userId) return;

  userData.delete(ws);

  for (const game of games.values()) {
    const playerIndex = game.players.findIndex((p) => p.index === userId);
    if (playerIndex === -1) continue;

    game.players.splice(playerIndex, 1);

    const playerData = game.players.map((p) => ({
      name: p.name,
      index: p.index,
      score: p.score,
    }));

    broadcastToGame(game, "update_players", playerData);

    if (game.status === "in_progress" && game.players.length > 0) {
      const allAnswered = game.players.every((p) =>
        game.playerAnswers.has(p.index),
      );
      if (allAnswered) {
        finishQuestion(game);
      }
    }

    if (game.status === "in_progress" && game.players.length === 0) {
      if (game.questionTimer) {
        clearTimeout(game.questionTimer);
        game.questionTimer = undefined;
      }
      game.status = "finished";
    }
  }
};

wss.on("connection", (ws) => {
  ws.on("close", () => {
    handleDisconnect(ws);
  });

  ws.on("error", () => {
    handleDisconnect(ws);
  });

  ws.on("message", (raw) => {
    let message: WSMessage;
    message = JSON.parse(raw.toString());

    const messageData =
      typeof message.data === "string"
        ? JSON.parse(message.data)
        : message.data;

    switch (message.type) {
      case "reg":
        handleLogin(ws, messageData as RegData);
        break;
      case "create_game":
        handleCreateGame(ws, messageData as CreateGameData);
        break;
      case "join_game":
        handleJoinGame(ws, messageData as JoinGameData);
        break;
      case "start_game":
        handleStartGame(ws, messageData as StartGameData);
        break;
      case "answer":
        handleAnswer(ws, messageData as AnswerData);
        break;
      default:
        send(ws, "error", { message: `Unknown command: ${message.type}` });
    }
  });
});

console.log(`WebSocket server running at ws://localhost:${PORT}`);
