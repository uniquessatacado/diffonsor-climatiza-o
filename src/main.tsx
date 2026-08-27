import React, { StrictMode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowLeft,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Clock3,
  Eye,
  EyeOff,
  Flag,
  ImagePlus,
  LockKeyhole,
  LogIn,
  LogOut,
  Mail,
  MapPin,
  Navigation,
  PauseCircle,
  PenLine,
  Play,
  RotateCcw,
  ShieldCheck,
  UserRound,
  WifiOff,
  Wrench,
  X,
} from "lucide-react";
import { isTestLoginEmail, login, requestPasswordReset } from "./services/auth";
import {
  fetchClosingQuestions,
  fetchServiceOrderDetails,
  fetchServiceOrders,
  getTestServiceOrders,
  serviceOrderStatuses,
  type ClosingQuestion,
  type ServiceOrder,
} from "./services/serviceOrders";
import {
  clearPendingActions,
  deletePendingAction,
  enqueueOfflineAction,
  getPendingActions,
  getPendingActionsCount,
  readCachedOrders,
  saveCachedOrders,
  setupOfflineSync,
  syncPendingActions,
  type PendingActionSummary,
  type OfflineActionType,
} from "./services/offlineSync";
import {
  deleteMedia,
  getMedia,
  savePreparedMediaFiles,
  type StoredMedia as SavedMedia,
} from "./services/mediaStore";
import { isApiNetworkError } from "./services/api";
import { addNetworkListener, isDeviceOnline, offlineNotice } from "./services/connectivity";
import { EquipmentRegistrationScreen } from "./components/EquipmentRegistrationScreen";
import "./styles.css";

const rememberedLoginKey = "diffonso.rememberedLogin";
const sessionKey = "diffonso.session";
const ordersCacheKey = "diffonso.cachedOrders";
const legacyPendingClearKey = "diffonso.legacy-pending-cleared.v6";
const testOrderId = "teste-1";
const maxMediaBytes = 12 * 1024 * 1024;
const maxTotalMediaBytes = 12 * 1024 * 1024;
const maxImageSourceBytes = 30 * 1024 * 1024;
const maxImageDimension = 1600;

type SavedLogin = {
  email: string;
  password: string;
};

type SavedSession = {
  email: string;
  data?: {
    id?: number | string;
    id_colaborador?: number | string;
    idColaborador?: number | string;
    nome?: string;
    email?: string;
    isTestUser?: boolean;
    [key: string]: unknown;
  };
};

function formatLastCheck(date: Date | null) {
  if (!date) {
    return "Aguardando primeira verificação";
  }

  return `Última verificação ${date.toLocaleDateString("pt-BR")} às ${date.toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

function formatElapsedTime(startedAt?: string) {
  if (!startedAt) {
    return "";
  }

  const start = new Date(startedAt).getTime();

  if (Number.isNaN(start)) {
    return "";
  }

  const totalMinutes = Math.max(0, Math.floor((Date.now() - start) / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];

  if (days > 0) {
    parts.push(`${days}d`);
  }

  if (hours > 0 || days > 0) {
    parts.push(`${hours}h`);
  }

  parts.push(`${minutes}min`);

  return parts.join(" ");
}

function shouldShowElapsedStatus(statusId: number) {
  return [2, 3, 4].includes(statusId);
}

const dashboardStatuses = [
  { id: 1, label: "Aguardando", icon: Clock3 },
  { id: 2, label: "Deslocamento", icon: Navigation },
  { id: 3, label: "Atendimento", icon: Play },
  { id: 4, label: "Suspensas", icon: PauseCircle },
  { id: 5, label: "Finalizadas", icon: CheckCircle2 },
];

function AutoFitStatusLabel({ label }: { label: string }) {
  const labelRef = useRef<HTMLSpanElement | null>(null);

  useLayoutEffect(() => {
    const element = labelRef.current;
    const container = element?.parentElement;

    if (!element || !container) {
      return;
    }

    function fitLabel(target: HTMLSpanElement) {
      let fontSize = 10;
      target.style.fontSize = `${fontSize}px`;

      while (target.scrollWidth > target.clientWidth && fontSize > 6) {
        fontSize -= 0.25;
        target.style.fontSize = `${fontSize}px`;
      }
    }

    fitLabel(element);
    const observer = new ResizeObserver(() => fitLabel(element));
    observer.observe(container);

    return () => observer.disconnect();
  }, [label]);

  return (
    <span className="dashboard-status-label" ref={labelRef}>
      {label}
    </span>
  );
}

function preserveStatusTimers(freshOrders: ServiceOrder[], previousOrders: ServiceOrder[]) {
  const previousById = new Map(previousOrders.map((order) => [order.id, order]));
  const capturedAt = new Date().toISOString();

  return freshOrders.map((order) => {
    if (order.statusStartedAt) {
      return order;
    }

    const previous = previousById.get(order.id);
    const knownStart =
      previous?.statusId === order.statusId && previous.statusStartedAt
        ? previous.statusStartedAt
        : capturedAt;

    return {
      ...order,
      statusStartedAt: knownStart,
    };
  });
}

function parseDatetimeAnswer(value: string | string[] | undefined | null) {
  if (Array.isArray(value) || value == null) {
    return { date: "", time: "" };
  }

  const [date = "", time = ""] = String(value).split("|");
  return { date, time };
}

function isQuestionAnswered(question: ClosingQuestion, answer: string | string[] | undefined) {
  if (Array.isArray(answer)) {
    return answer.length > 0;
  }

  if (question.step === "datetime") {
    const parsed = parseDatetimeAnswer(answer);
    return parsed.date.trim() !== "" && parsed.time.trim() !== "";
  }

  return String(answer ?? "").trim() !== "";
}

function navigateTo(path: string) {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function getClosingDraftKey(orderId: string) {
  return `diffonso.closingDraft.${orderId}`;
}

function routeFromPath(pathname: string) {
  const orderMatch = pathname.match(/^\/ordem\/([^/]+)$/);

  return {
    page: orderMatch
      ? "order"
      : pathname === "/equipamentos/novo"
        ? "equipment-registration"
        : pathname === "/ordens"
          ? "orders"
          : "login",
    orderId: orderMatch?.[1] ?? null,
  };
}

function readSavedSession() {
  try {
    const session = localStorage.getItem(sessionKey) || sessionStorage.getItem(sessionKey);

    return session ? (JSON.parse(session) as SavedSession) : null;
  } catch {
    localStorage.removeItem(sessionKey);
    sessionStorage.removeItem(sessionKey);
    return null;
  }
}

function cleanupLargeDrafts() {
  try {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);

      if (!key?.startsWith("diffonso.closingDraft.")) {
        continue;
      }

      const value = localStorage.getItem(key);

      if (value && value.length > 500_000) {
        localStorage.removeItem(key);
      }
    }
  } catch {
    // If storage is blocked, the app still works with in-memory form state.
  }
}

function saveSession(session: SavedSession) {
  const serialized = JSON.stringify(session);

  try {
    localStorage.setItem(sessionKey, serialized);
  } catch {
    sessionStorage.setItem(sessionKey, serialized);
  }
}

function findCollaboratorId(value: unknown, depth = 0): number | string {
  if (!value || typeof value !== "object" || depth > 8) {
    return "";
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const nestedId = findCollaboratorId(item, depth + 1);
      if (nestedId !== "") {
        return nestedId;
      }
    }
    return "";
  }

  const record = value as Record<string, unknown>;
  const directCandidates = Object.entries(record)
    .filter(([key]) => /^(id_colaborador|idColaborador|codigo_colaborador|codigoColaborador|colaborador_id)$/i.test(key))
    .map(([, candidate]) => candidate);

  directCandidates.push(record.id);

  for (const candidate of directCandidates) {
    if ((typeof candidate === "string" || typeof candidate === "number") && String(candidate).trim() !== "") {
      return candidate;
    }
  }

  for (const key of ["data", "dados", "colaborador", "usuario", "user", "perfil"]) {
    const nestedId = findCollaboratorId(record[key], depth + 1);
    if (nestedId !== "") {
      return nestedId;
    }
  }

  // Algumas versoes da API retornam `dados` como lista. Ao salvar a sessao,
  // essa lista pode virar um objeto com chaves "0", "1", etc.
  for (const nestedValue of Object.values(record)) {
    if (!nestedValue || typeof nestedValue !== "object") {
      continue;
    }

    const nestedId = findCollaboratorId(nestedValue, depth + 1);
    if (nestedId !== "") {
      return nestedId;
    }
  }

  return "";
}

function getCollaboratorId(session?: SavedSession | null) {
  const sessionId = findCollaboratorId(session?.data) || findCollaboratorId(session);

  if (sessionId !== "") {
    return sessionId;
  }

  try {
    const rawAuthResponse =
      sessionStorage.getItem("diffonso.authResponse") || localStorage.getItem("diffonso.authResponse");
    return rawAuthResponse ? findCollaboratorId(JSON.parse(rawAuthResponse)) : "";
  } catch {
    return "";
  }
}

function isTestSession(session?: SavedSession | null) {
  return isTestLoginEmail(session?.email ?? "") || session?.data?.isTestUser === true;
}

function getOrdersCacheKey(session?: SavedSession | null) {
  const userKey = isTestSession(session) ? "teste" : String(session?.data?.id ?? session?.email ?? "anonimo");
  return `${ordersCacheKey}.${userKey}`;
}

async function readOrdersCache(session?: SavedSession | null) {
  const key = getOrdersCacheKey(session);

  try {
    const cachedDb = await readCachedOrders<ServiceOrder>(key);

    if (cachedDb?.orders.length) {
      return cachedDb;
    }
  } catch {
    // LocalStorage fallback keeps older caches readable.
  }

  try {
    const cachedLocal = localStorage.getItem(key);

    if (cachedLocal) {
      return {
        orders: JSON.parse(cachedLocal) as ServiceOrder[],
        updatedAt: undefined,
      };
    }
  } catch {
    localStorage.removeItem(key);
  }

  return null;
}

async function writeOrdersCache(session: SavedSession | null | undefined, orders: ServiceOrder[]) {
  const key = getOrdersCacheKey(session);
  await saveCachedOrders(key, orders);

  try {
    localStorage.setItem(key, JSON.stringify(orders));
  } catch {
    // IndexedDB remains the main cache.
  }
}

function formatPendingType(type: OfflineActionType) {
  if (type === "status_change") {
    return "Mudança de status";
  }

  if (type === "suspend_order") {
    return "Suspensão";
  }

  return "Finalização";
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function resolveMediaType(file: File) {
  if (file.type) {
    return file.type;
  }

  const extension = file.name.split(".").pop()?.toLowerCase();

  if (["jpg", "jpeg", "png", "webp", "gif", "heic", "heif"].includes(extension ?? "")) {
    return "image/*";
  }

  if (["mp4", "mov", "webm", "mkv", "avi"].includes(extension ?? "")) {
    return "video/*";
  }

  return "application/octet-stream";
}

function isImageFile(file: File) {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";

  return file.type.startsWith("image/") || ["jpg", "jpeg", "png", "webp"].includes(extension);
}

async function optimizeImageForUpload(file: File) {
  if (!isImageFile(file) || /gif|svg|heic|heif/i.test(file.type + file.name)) {
    return file;
  }

  const sourceUrl = URL.createObjectURL(file);

  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const nextImage = new Image();

      nextImage.onload = () => resolve(nextImage);
      nextImage.onerror = () => reject(new Error("Image decode failed"));
      nextImage.src = sourceUrl;
    });
    const largestDimension = Math.max(image.naturalWidth, image.naturalHeight);
    const scale = Math.min(1, maxImageDimension / Math.max(1, largestDimension));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");

    if (!context) {
      return file;
    }

    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const optimizedBlob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", 0.8);
    });

    if (!optimizedBlob || (scale === 1 && optimizedBlob.size >= file.size)) {
      return file;
    }

    const baseName = file.name.replace(/\.[^.]+$/, "") || "foto";
    return new File([optimizedBlob], `${baseName}.jpg`, {
      type: "image/jpeg",
      lastModified: file.lastModified,
    });
  } catch {
    return file;
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

function createLocalId() {
  const randomPart =
    typeof crypto !== "undefined" && "getRandomValues" in crypto
      ? Array.from(crypto.getRandomValues(new Uint32Array(2)))
          .map((value) => value.toString(36))
          .join("")
      : Math.random().toString(36).slice(2);

  return `${Date.now()}-${randomPart}`;
}

type MediaAnswer = SavedMedia & {
  previewUrl?: string;
  previewDataUrl?: string;
  status?: "encoding" | "ready" | "error";
};

function inferMediaType(name: string) {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";

  if (["jpg", "jpeg", "png", "webp", "gif", "heic", "heif"].includes(extension)) {
    return "image/*";
  }

  if (["mp4", "mov", "webm", "mkv", "avi"].includes(extension)) {
    return "video/*";
  }

  return "application/octet-stream";
}

function normalizeStoredMedia(value: unknown): MediaAnswer | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const name = typeof record.name === "string" && record.name.trim() ? record.name : "midia";
  const size = Number(record.size);

  if (!id || !Number.isFinite(size) || size < 0) {
    return null;
  }

  return {
    id,
    name,
    type: typeof record.type === "string" && record.type.trim() ? record.type : inferMediaType(name),
    size,
    createdAt:
      typeof record.createdAt === "string" && record.createdAt
        ? record.createdAt
        : new Date(0).toISOString(),
    ...(typeof record.previewUrl === "string" ? { previewUrl: record.previewUrl } : {}),
    ...(typeof record.previewDataUrl === "string" ? { previewDataUrl: record.previewDataUrl } : {}),
    ...(record.status === "encoding" || record.status === "ready" || record.status === "error"
      ? { status: record.status }
      : {}),
  };
}

function parseStoredMedia(value: unknown) {
  try {
    return normalizeStoredMedia(typeof value === "string" ? JSON.parse(value) : value);
  } catch {
    return null;
  }
}

function isMediaAnswer(value: string | string[]) {
  return Array.isArray(value) && value.some((item) => Boolean(parseStoredMedia(item)));
}

function stripMediaPreviewFields(value: string | string[]) {
  if (!Array.isArray(value)) {
    return value;
  }

  return value.map((item) => {
    const media = parseStoredMedia(item);

    if (!media) {
      return item;
    }

    const {
      previewUrl: _previewUrl,
      previewDataUrl: _previewDataUrl,
      status: _status,
      ...storedMedia
    } = media;

    return JSON.stringify(storedMedia);
  });
}

function prepareClosingDraftForStorage(answers: Record<string, string | string[]>) {
  return Object.fromEntries(
    Object.entries(answers).map(([questionId, value]) => [
      questionId,
      isMediaAnswer(value) ? stripMediaPreviewFields(value) : value,
    ]),
  );
}

function saveClosingDraft(orderId: string, answers: Record<string, string | string[]>) {
  localStorage.setItem(
    getClosingDraftKey(orderId),
    JSON.stringify(prepareClosingDraftForStorage(answers)),
  );
}

async function restoreClosingDraft(
  savedDraft: string | null,
  questions: ClosingQuestion[],
): Promise<{ answers: Record<string, string | string[]>; removedMedia: number }> {
  if (!savedDraft) {
    return { answers: {}, removedMedia: 0 };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(savedDraft);
  } catch {
    return { answers: {}, removedMedia: 0 };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { answers: {}, removedMedia: 0 };
  }

  const storedAnswers = parsed as Record<string, unknown>;
  const answers: Record<string, string | string[]> = {};
  let removedMedia = 0;

  for (const question of questions) {
    const value = storedAnswers[question.id];

    if (question.step === "media") {
      const restoredMedia: string[] = [];

      for (const item of Array.isArray(value) ? value : []) {
        const media = parseStoredMedia(item);

        if (!media) {
          removedMedia += 1;
          continue;
        }

        try {
          const stored = await getMedia(media.id);

          if (!stored?.blob || stored.blob.size <= 0) {
            removedMedia += 1;
            continue;
          }

          restoredMedia.push(
            JSON.stringify({
              id: stored.id,
              name: stored.name || media.name,
              type: stored.type || media.type || inferMediaType(stored.name || media.name),
              size: stored.blob.size,
              createdAt: stored.createdAt || media.createdAt,
            } satisfies SavedMedia),
          );
        } catch {
          removedMedia += 1;
        }
      }

      answers[question.id] = restoredMedia;
      continue;
    }

    if (question.step === "checkbox") {
      answers[question.id] = Array.isArray(value)
        ? value
            .filter((item) => typeof item === "string" || typeof item === "number")
            .map(String)
        : [];
      continue;
    }

    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      answers[question.id] = String(value);
    }
  }

  return { answers, removedMedia };
}

function releaseMediaPreviewUrls(answers: Record<string, string | string[]>) {
  Object.values(answers).forEach((answer) => {
    if (!Array.isArray(answer)) {
      return;
    }

    answer.forEach((item) => {
      const media = parseStoredMedia(item);

      if (media?.previewUrl) {
        URL.revokeObjectURL(media.previewUrl);
      }
    });
  });
}

function MediaPreview({ item, onRemove }: { item: string; onRemove: () => void }) {
  const media = parseStoredMedia(item);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [restoredPreviewUrl, setRestoredPreviewUrl] = useState("");

  useEffect(() => {
    if (!media?.id || media.previewUrl) {
      return;
    }

    let objectUrl = "";

    void getMedia(media.id).then((stored) => {
      if (!stored) {
        return;
      }

      objectUrl = URL.createObjectURL(stored.blob);
      setRestoredPreviewUrl(objectUrl);
    });

    return () => {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [media?.id, media?.previewUrl]);

  if (!media) {
    return null;
  }

  const previewSource = media.previewUrl || restoredPreviewUrl || media.previewDataUrl;
  const mediaType = media.type || inferMediaType(media.name);
  const canShowImage = mediaType.startsWith("image/") && previewSource && !previewFailed;
  const canShowVideo = mediaType.startsWith("video/") && previewSource && !previewFailed;

  return (
    <div className="media-preview">
      {canShowImage ? (
        <img src={previewSource} alt={media.name} onError={() => setPreviewFailed(true)} />
      ) : canShowVideo ? (
        <video
          src={previewSource}
          muted
          controls
          playsInline
          preload="metadata"
          onError={() => setPreviewFailed(true)}
        />
      ) : (
        <div className="media-file">
          <ImagePlus size={24} />
          <span>{mediaType.startsWith("video/") ? "Vídeo selecionado" : "Mídia selecionada"}</span>
        </div>
      )}
      <div className="media-name">
        <strong>{media.name || "Arquivo"}</strong>
        <span>{formatBytes(media.size)}</span>
      </div>
      {media.status === "encoding" && <span className="media-status">Preparando...</span>}
      {media.status === "error" && <span className="media-status error">Falhou</span>}
      <button type="button" onClick={onRemove}>
        Remover
      </button>
    </div>
  );
}

type ClosingModalProps = {
  answers: Record<string, string | string[]>;
  currentStep: number;
  onAnswer: (questionId: string, value: string | string[]) => void;
  onBack: () => void;
  onClose: () => void;
  onFinish: () => void;
  onNext: () => void;
  questions: ClosingQuestion[];
  submitting: boolean;
};

type AppErrorBoundaryProps = {
  children: React.ReactNode;
};

type AppErrorBoundaryState = {
  hasError: boolean;
};

class AppErrorBoundary extends React.Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.error(error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="app-shell app-shell-orders">
          <section className="orders-screen">
            <div className="simple-modal inline-error">
              <X size={42} />
              <h2>Algo saiu do formato esperado</h2>
              <p>Recarregue as ordens para continuar. O rascunho salvo continua guardado.</p>
              <button
                type="button"
                className="primary-button"
                onClick={() => {
                  this.setState({ hasError: false });
                  window.location.assign("/ordens");
                }}
              >
                Voltar para ordens
              </button>
            </div>
          </section>
        </main>
      );
    }

    return this.props.children;
  }
}

function ClosingModal({
  answers,
  currentStep,
  onAnswer,
  onBack,
  onClose,
  onFinish,
  onNext,
  questions,
  submitting,
}: ClosingModalProps) {
  const question = questions[currentStep];
  const isLastStep = currentStep === questions.length - 1;
  const answer = question ? answers[question.id] : "";
  const isAnswered = question ? isQuestionAnswered(question, answer) : false;
  const canContinue = question ? !question.required || isAnswered : false;
  const isSignatureStep = question?.step === "signature";
  const answerRef = useRef(answer);
  const [mediaError, setMediaError] = useState("");
  const [preparingMedia, setPreparingMedia] = useState(false);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const videoInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    answerRef.current = answer;
  }, [answer]);

  if (!question) {
    return null;
  }

  function toggleOption(optionId: string) {
    const current = Array.isArray(answer) ? answer : [];
    const next = current.includes(optionId)
      ? current.filter((item) => item !== optionId)
      : [...current, optionId];

    onAnswer(question.id, next);
  }

  async function appendMedia(files: FileList | null) {
    const fileList = Array.from(files ?? []);

    if (fileList.length === 0) {
      return;
    }

    setPreparingMedia(true);
    const tooLargeAtSource = fileList.filter(
      (file) => file.size > (isImageFile(file) ? maxImageSourceBytes : maxMediaBytes),
    );
    const candidates = fileList.filter(
      (file) => file.size <= (isImageFile(file) ? maxImageSourceBytes : maxMediaBytes),
    );
    const preparedFiles = await Promise.all(candidates.map((file) => optimizeImageForUpload(file)));
    const tooLargeAfterOptimization = preparedFiles.filter((file) => file.size > maxMediaBytes);
    const current = Array.isArray(answerRef.current) ? answerRef.current : [];
    const currentBytes = Object.entries(answers).reduce((total, [answerId, storedAnswer]) => {
      const mediaItems =
        answerId === question.id
          ? current
          : Array.isArray(storedAnswer)
            ? storedAnswer
            : [];

      return total + mediaItems.reduce((subtotal, item) => subtotal + (parseStoredMedia(item)?.size ?? 0), 0);
    }, 0);
    let selectedBytes = currentBytes;
    const acceptedFiles: File[] = [];
    const overTotalLimit: File[] = [];

    preparedFiles
      .filter((file) => file.size <= maxMediaBytes)
      .forEach((file) => {
        if (selectedBytes + file.size > maxTotalMediaBytes) {
          overTotalLimit.push(file);
          return;
        }

        selectedBytes += file.size;
        acceptedFiles.push(file);
      });
    const oversized = [...tooLargeAtSource, ...tooLargeAfterOptimization, ...overTotalLimit];

    if (oversized.length > 0) {
      setMediaError(
        `Limite seguro de 12 MB no total: ${oversized.map((file) => `${file.name} (${formatBytes(file.size)})`).join(", ")} nao foi incluída. Fotos comuns sao reduzidas automaticamente.`,
      );
    } else {
      setMediaError("");
    }

    if (acceptedFiles.length === 0) {
      setPreparingMedia(false);
      return;
    }

    const prepared = acceptedFiles.map((file) => {
      const metadata: SavedMedia = {
        id: createLocalId(),
        name: file.name || "midia",
        type: resolveMediaType(file),
        size: file.size,
        createdAt: new Date().toISOString(),
      };

      return {
        file,
        metadata,
      };
    });
    try {
      await savePreparedMediaFiles(prepared);
      const latest = Array.isArray(answerRef.current) ? answerRef.current : [];
      const nextMedia = prepared.map(({ metadata, file }) =>
        JSON.stringify({
          ...metadata,
          previewUrl: URL.createObjectURL(file),
          status: "ready",
        } satisfies MediaAnswer),
      );
      const next = [...latest, ...nextMedia];

      answerRef.current = next;
      onAnswer(question.id, next);
    } catch {
      await Promise.all(prepared.map((item) => deleteMedia(item.metadata.id).catch(() => undefined)));
      setMediaError("Não foi possível guardar esta mídia no aparelho. Selecione o arquivo novamente.");
    } finally {
      setPreparingMedia(false);
    }
  }

  function removeMedia(item: string) {
    const media = parseStoredMedia(item);

    if (media?.previewUrl) {
      URL.revokeObjectURL(media.previewUrl);
    }

    if (media?.id) {
      void deleteMedia(media.id);
    }

    const latest = Array.isArray(answerRef.current) ? answerRef.current : [];
    const next = latest.filter((current) => current !== item);
    answerRef.current = next;
    onAnswer(question.id, next);
  }

  function handleInputFiles(input: HTMLInputElement) {
    void appendMedia(input.files);
    input.value = "";
  }

  return (
    <div
      className={`modal-overlay ${isSignatureStep ? "signature-overlay" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="closing-title"
    >
      <section className={`closing-modal ${isSignatureStep ? "signature-modal" : ""}`}>
        {!isSignatureStep && (
          <header className="closing-modal-header">
            <div>
              <span>
                Etapa {currentStep + 1} de {questions.length}
              </span>
              <h2 id="closing-title">{question.label}</h2>
            </div>
            <button type="button" className="icon-button" onClick={onClose} disabled={submitting} aria-label="Fechar" title="Fechar">
              <X size={22} />
            </button>
          </header>
        )}

        <div className="closing-modal-body">
          {question.step === "text" && (
            <input
              className="large-input"
              value={String(answer ?? "")}
              onChange={(event) => onAnswer(question.id, event.target.value)}
              placeholder="Digite a resposta"
            />
          )}

          {question.step === "date" && (
            <input
              className="large-input"
              type="date"
              value={String(answer ?? "")}
              onChange={(event) => onAnswer(question.id, event.target.value)}
            />
          )}

          {question.step === "datetime" && (
            <div className="datetime-fields">
              <input
                className="large-input"
                type="date"
                value={parseDatetimeAnswer(answer).date}
                onChange={(event) =>
                  onAnswer(question.id, `${event.target.value}|${parseDatetimeAnswer(answer).time}`)
                }
              />
              <input
                className="large-input"
                type="time"
                value={parseDatetimeAnswer(answer).time}
                onChange={(event) =>
                  onAnswer(question.id, `${parseDatetimeAnswer(answer).date}|${event.target.value}`)
                }
              />
            </div>
          )}

          {question.step === "media" && (
            <div className="media-step">
              {Array.isArray(answer) && answer.length > 0 && (
                <p className="selected-media">{answer.length} mídia(s) adicionada(s)</p>
              )}
              <button type="button" className="media-action" disabled={preparingMedia || submitting} onClick={() => galleryInputRef.current?.click()}>
                <ImagePlus size={22} />
                <span>Selecionar mídia</span>
              </button>
              <button type="button" className="media-action" disabled={preparingMedia || submitting} onClick={() => photoInputRef.current?.click()}>
                <ImagePlus size={22} />
                <span>Tirar foto</span>
              </button>
              <button type="button" className="media-action" disabled={preparingMedia || submitting} onClick={() => videoInputRef.current?.click()}>
                <ImagePlus size={22} />
                <span>Gravar vídeo</span>
              </button>
              <input
                ref={galleryInputRef}
                className="native-file-input"
                type="file"
                accept="image/*,video/*"
                multiple
                onChange={(event) => handleInputFiles(event.currentTarget)}
              />
              <input
                ref={photoInputRef}
                className="native-file-input"
                type="file"
                accept="image/*"
                capture="environment"
                onChange={(event) => handleInputFiles(event.currentTarget)}
              />
              <input
                ref={videoInputRef}
                className="native-file-input"
                type="file"
                accept="video/*"
                capture="environment"
                onChange={(event) => handleInputFiles(event.currentTarget)}
              />
              {preparingMedia && <p className="selected-media">Preparando e salvando mídia...</p>}
              {mediaError && <p className="required-message">{mediaError}</p>}
              {Array.isArray(answer) && answer.length > 0 && (
                <div className="media-preview-grid">
                  {answer.map((item) => (
                    <MediaPreview
                      item={item}
                      key={parseStoredMedia(item)?.id ?? item}
                      onRemove={() => removeMedia(item)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {question.step === "checkbox" && (
            <div className="option-list">
              {question.options?.map((option) => (
                <label key={option.id}>
                  <input
                    type="checkbox"
                    checked={Array.isArray(answer) && answer.includes(option.id)}
                    onChange={() => toggleOption(option.id)}
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          )}

          {question.step === "radio" && (
            <div className="option-list">
              {question.options?.map((option) => (
                <label key={option.id}>
                  <input
                    type="radio"
                    name={question.id}
                    checked={answer === option.id}
                    onChange={() => onAnswer(question.id, option.id)}
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          )}

          {question.step === "textarea" && (
            <textarea
              className="large-textarea"
              rows={7}
              value={String(answer ?? "")}
              onChange={(event) => onAnswer(question.id, event.target.value)}
              placeholder="Digite uma observação"
            />
          )}

          {question.step === "responsible" && (
            <input
              className="large-input"
              value={String(answer ?? "")}
              onChange={(event) => onAnswer(question.id, event.target.value)}
              placeholder="Nome completo"
            />
          )}

          {isSignatureStep && (
            <SignaturePad
              value={String(answer ?? "")}
              onChange={(value) => onAnswer(question.id, value)}
            />
          )}

          {question.required && !canContinue && !isSignatureStep && (
            <p className="required-message">Este campo é obrigatório.</p>
          )}
        </div>

        <footer className="closing-modal-footer">
          <button type="button" className="stage-button secondary" onClick={onBack} disabled={currentStep === 0 || submitting || preparingMedia}>
            Voltar
          </button>
          <button
            type="button"
            className="stage-button"
            onClick={isLastStep ? onFinish : onNext}
            disabled={!canContinue || submitting || preparingMedia}
          >
            {submitting && isLastStep ? "Enviando..." : isLastStep ? "Finalizar" : "Próximo"}
          </button>
        </footer>
      </section>
    </div>
  );
}

type SuspendModalProps = {
  onCancel: () => void;
  onConfirm: (reason: string) => void;
};

function SuspendModal({ onCancel, onConfirm }: SuspendModalProps) {
  const [reason, setReason] = useState("");

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="suspend-title">
      <section className="simple-modal">
        <header className="closing-modal-header">
          <div>
            <span>Suspender atendimento</span>
            <h2 id="suspend-title">Informe o motivo da suspensão</h2>
          </div>
          <button type="button" className="icon-button" onClick={onCancel} aria-label="Fechar" title="Fechar">
            <X size={22} />
          </button>
        </header>
        <div className="closing-modal-body">
          <textarea
            className="large-textarea"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Digite o motivo"
            rows={6}
          />
          {!reason.trim() && <p className="required-message">O motivo é obrigatório.</p>}
        </div>
        <footer className="closing-modal-footer">
          <button type="button" className="stage-button secondary" onClick={onCancel}>
            Voltar
          </button>
          <button
            type="button"
            className="stage-button"
            disabled={!reason.trim()}
            onClick={() => onConfirm(reason)}
          >
            Suspender
          </button>
        </footer>
      </section>
    </div>
  );
}

type SignaturePadProps = {
  value: string;
  onChange: (value: string) => void;
};

function SignaturePad({ value, onChange }: SignaturePadProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const drawingRef = useRef(false);
  const valueRef = useRef(value);
  const [isLandscape, setIsLandscape] = useState(
    window.matchMedia("(orientation: landscape)").matches,
  );

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  function resizeCanvas() {
    const canvas = canvasRef.current;
    const wrapper = wrapperRef.current;

    if (!canvas || !wrapper) {
      return;
    }

    const rect = wrapper.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.floor(rect.width * ratio));
    canvas.height = Math.max(1, Math.floor(rect.height * ratio));
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;

    const context = canvas.getContext("2d");

    if (!context) {
      return;
    }

    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, rect.width, rect.height);
    context.lineWidth = 3.2;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = "#0d1037";

    if (valueRef.current) {
      const savedSignature = new Image();

      savedSignature.onload = () => {
        context.drawImage(savedSignature, 0, 0, rect.width, rect.height);
      };
      savedSignature.src = valueRef.current;
    }
  }

  function getPoint(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;

    if (!canvas) {
      return { x: 0, y: 0 };
    }

    const rect = canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  }

  function startDrawing(event: React.PointerEvent<HTMLCanvasElement>) {
    event.preventDefault();
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");

    if (!canvas || !context) {
      return;
    }

    drawingRef.current = true;
    canvas.setPointerCapture(event.pointerId);
    const point = getPoint(event);
    context.beginPath();
    context.moveTo(point.x, point.y);
  }

  function draw(event: React.PointerEvent<HTMLCanvasElement>) {
    event.preventDefault();
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");

    if (!canvas || !context || !drawingRef.current) {
      return;
    }

    const point = getPoint(event);
    context.lineTo(point.x, point.y);
    context.stroke();
  }

  function stopDrawing() {
    if (!drawingRef.current) {
      return;
    }

    drawingRef.current = false;
    const canvas = canvasRef.current;

    if (canvas) {
      onChange(canvas.toDataURL("image/png"));
    }
  }

  function clearSignature() {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");

    if (!canvas || !context) {
      return;
    }

    const rect = canvas.getBoundingClientRect();
    context.clearRect(0, 0, rect.width, rect.height);
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, rect.width, rect.height);
    onChange("");
  }

  useEffect(() => {
    const media = window.matchMedia("(orientation: landscape)");

    function handleOrientation() {
      setIsLandscape(media.matches);
      window.setTimeout(resizeCanvas, 120);
    }

    handleOrientation();
    media.addEventListener("change", handleOrientation);
    window.addEventListener("resize", handleOrientation);
    window.visualViewport?.addEventListener("resize", handleOrientation);

    return () => {
      media.removeEventListener("change", handleOrientation);
      window.removeEventListener("resize", handleOrientation);
      window.visualViewport?.removeEventListener("resize", handleOrientation);
    };
  }, []);

  useEffect(() => {
    if (isLandscape) {
      window.setTimeout(resizeCanvas, 80);
    }
  }, [isLandscape]);

  return (
    <div className={`signature-step ${isLandscape ? "ready" : "rotate-required"}`}>
      {!isLandscape ? (
        <div className="rotate-phone">
          <RotateCcw size={58} />
          <h3>Gire o celular</h3>
          <p>Deite o aparelho na horizontal para liberar o campo de assinatura.</p>
        </div>
      ) : (
        <>
          <div className="signature-title">
            <PenLine size={20} />
            <span>Assinatura do responsável</span>
          </div>
          <div className="signature-canvas-wrap" ref={wrapperRef}>
            <canvas
              ref={canvasRef}
              onPointerDown={startDrawing}
              onPointerMove={draw}
              onPointerUp={stopDrawing}
              onPointerLeave={stopDrawing}
              onPointerCancel={stopDrawing}
            />
          </div>
          <div className="signature-actions">
            <button type="button" className="text-button" onClick={clearSignature}>
              Limpar assinatura
            </button>
            {value && <span>Assinatura capturada</span>}
          </div>
        </>
      )}
    </div>
  );
}

function App() {
  const savedSession = useMemo(() => readSavedSession(), []);
  const [route, setRoute] = useState(() => routeFromPath(window.location.pathname));
  const [email, setEmail] = useState(savedSession?.email ?? "");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [orders, setOrders] = useState<ServiceOrder[]>([]);
  const [statusFilter, setStatusFilter] = useState<number | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null);
  const [isOnline, setIsOnline] = useState<boolean | null>(null);
  const [pendingSyncCount, setPendingSyncCount] = useState(0);
  const [pendingActions, setPendingActions] = useState<PendingActionSummary[]>([]);
  const [showPendingList, setShowPendingList] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");
  const [_elapsedTicker, setElapsedTicker] = useState(0);
  const [closingOrder, setClosingOrder] = useState(false);
  const [suspendingOrder, setSuspendingOrder] = useState(false);
  const [closingStep, setClosingStep] = useState(0);
  const [closingQuestions, setClosingQuestions] = useState<ClosingQuestion[]>([]);
  const [closingAnswers, setClosingAnswers] = useState<Record<string, string | string[]>>({});
  const [closingSubmitting, setClosingSubmitting] = useState(false);
  const [finishModal, setFinishModal] = useState(false);
  const [finishQueuedOffline, setFinishQueuedOffline] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"info" | "error" | "success">("info");
  const [isLoggedIn, setIsLoggedIn] = useState(Boolean(savedSession));
  const [errorModal, setErrorModal] = useState("");

  const selectedOrder = useMemo(
    () => orders.find((order) => order.id === route.orderId) ?? null,
    [orders, route.orderId],
  );
  const statusCounts = useMemo(
    () =>
      Object.fromEntries(
        dashboardStatuses.map(({ id }) => [id, orders.filter((order) => order.statusId === id).length]),
      ) as Record<number, number>,
    [orders],
  );
  const visibleOrders = useMemo(
    () => (statusFilter === null ? orders : orders.filter((order) => order.statusId === statusFilter)),
    [orders, statusFilter],
  );
  const canSubmit = useMemo(() => email.trim() !== "" && password.trim() !== "", [email, password]);

  function showOfflineNotice() {
    setIsOnline(false);
    setSyncMessage(offlineNotice);
  }

  useEffect(() => {
    cleanupLargeDrafts();

    function handleRouteChange() {
      setRoute(routeFromPath(window.location.pathname));
    }

    window.addEventListener("popstate", handleRouteChange);
    return () => window.removeEventListener("popstate", handleRouteChange);
  }, []);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [route.page, route.orderId]);

  useEffect(() => {
    const timer = window.setInterval(() => setElapsedTicker((current) => current + 1), 15000);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const shouldLockScroll = closingOrder || suspendingOrder || finishModal || showPendingList;

    document.body.classList.toggle("modal-open", shouldLockScroll);

    return () => document.body.classList.remove("modal-open");
  }, [closingOrder, suspendingOrder, finishModal, showPendingList]);

  useEffect(() => {
    const session = readSavedSession();

    void readOrdersCache(session).then((cached) => {
      if (cached?.orders.length) {
        setOrders(cached.orders);
      }
    });
  }, []);

  useEffect(() => {
    const session = readSavedSession();

    if (orders.length > 0) {
      void writeOrdersCache(session, orders);
    }
  }, [orders]);

  useEffect(() => {
    let removeNetworkListener: (() => Promise<void>) | undefined;

    async function trySync() {
      const result = await syncPendingActions();
      setPendingSyncCount(result.pending);

      if (result.offline) {
        showOfflineNotice();
        return;
      }

      if (result.error) {
        setErrorModal(result.error);
      }

      if (result.synced > 0) {
        setSyncMessage(`${result.synced} alteração(ões) sincronizada(s).`);
      } else if (result.missingUrl && result.pending > 0) {
        setSyncMessage("Pendências salvas. Configure a URL da API para sincronizar.");
      }
    }

    function handleConnectivityChange(connected: boolean) {
      if (!connected) {
        showOfflineNotice();
        return;
      }

      setIsOnline(true);
      void (async () => {
        await trySync();
        await loadServiceOrders();
      })();
    }

    void (async () => {
      await setupOfflineSync();
      removeNetworkListener = await addNetworkListener(handleConnectivityChange);
      const connected = await isDeviceOnline();

      if (connected) {
        setIsOnline(true);
      } else {
        showOfflineNotice();
      }

      if (!localStorage.getItem(legacyPendingClearKey)) {
        await clearPendingActions();
        localStorage.setItem(legacyPendingClearKey, "1");
        if (connected) {
          setSyncMessage("Pendencias antigas limpas.");
        }
      }

      setPendingSyncCount(await getPendingActionsCount());
      if (connected) {
        await trySync();
      }
    })();

    return () => {
      void removeNetworkListener?.();
    };
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem(rememberedLoginKey);
    const session = localStorage.getItem(sessionKey) || sessionStorage.getItem(sessionKey);

    if (saved) {
      try {
        const parsed = JSON.parse(saved) as SavedLogin;
        setEmail(parsed.email ?? "");
        setPassword(parsed.password ?? "");
        setRemember(true);
      } catch {
        localStorage.removeItem(rememberedLoginKey);
      }
    }

    if (session) {
      try {
        const parsedSession = JSON.parse(session) as SavedSession;
        setEmail((current) => current || parsedSession.email);
        setIsLoggedIn(true);

        if (window.location.pathname === "/" || window.location.pathname === "/login") {
          navigateTo("/ordens");
        }
      } catch {
        localStorage.removeItem(sessionKey);
        sessionStorage.removeItem(sessionKey);
      }
    }
  }, []);

  useEffect(() => {
    if (!isLoggedIn && route.page !== "login") {
      navigateTo("/login");
      return;
    }

    if (isLoggedIn && (route.page === "orders" || route.page === "order")) {
      void loadServiceOrders();
    }
  }, [isLoggedIn, route.page]);

  useEffect(() => {
    if (!isLoggedIn || route.page !== "order" || !route.orderId) {
      return;
    }

    void loadServiceOrderDetails(route.orderId);
  }, [isLoggedIn, route.page, route.orderId, selectedOrder?.apiOrderCode]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!canSubmit) {
      setMessageType("error");
      setMessage("Preencha email e senha para entrar.");
      return;
    }

    setLoading(true);
    setMessage("");
    setErrorModal("");

    const result = await login({
      email: email.trim(),
      password,
    });

    setLoading(false);
    setMessage(result.message);
    setMessageType(result.ok ? "success" : "error");
    setIsLoggedIn(result.ok);

    if (result.offline) {
      showOfflineNotice();
    }

    if (!result.ok && !result.offline) {
      setErrorModal(result.message);
    }

    if (result.ok) {
      const cleanEmail = email.trim();
      const sessionData = result.data as SavedSession["data"];

      if (remember) {
        localStorage.setItem(rememberedLoginKey, JSON.stringify({ email: cleanEmail, password }));
      } else {
        localStorage.removeItem(rememberedLoginKey);
      }

      saveSession({ email: cleanEmail, data: sessionData });
      sessionStorage.setItem("diffonso.authResponse", JSON.stringify(result.data ?? {}));
      setOrders([]);
      await loadServiceOrders(getCollaboratorId({ email: cleanEmail, data: sessionData }));
      navigateTo("/ordens");
    }
  }

  async function loadServiceOrders(idColaborador = getCollaboratorId(readSavedSession())) {
    const session = readSavedSession();

    if (isTestSession(session)) {
      setOrders((current) => {
        const testOrder = getTestServiceOrders()[0];
        const currentOrder = current.find((item) => item.id === testOrder.id);

        return [
          currentOrder
            ? {
                ...testOrder,
                statusId: currentOrder.statusId,
                status: currentOrder.status,
                statusStartedAt: currentOrder.statusStartedAt ?? testOrder.statusStartedAt,
              }
            : testOrder,
        ];
      });
      setLastCheckedAt(new Date());
      return;
    }

    if (!idColaborador) {
      return;
    }

    setOrdersLoading(true);

    try {
      const connected = await isDeviceOnline();

      if (!connected) {
        showOfflineNotice();
        const cached = await readOrdersCache(session);

        if (cached?.orders.length) {
          setOrders(cached.orders);
          setLastCheckedAt(cached.updatedAt ? new Date(cached.updatedAt) : new Date());
        }

        return;
      }

      setIsOnline(true);
      const serviceOrders = await fetchServiceOrders(idColaborador);
      const cached = await readOrdersCache(session);

      setOrders((current) => preserveStatusTimers(serviceOrders, current.length ? current : (cached?.orders ?? [])));
      setLastCheckedAt(new Date());
      setSyncMessage((current) => (current === offlineNotice ? "" : current));
    } catch (error) {
      const cached = await readOrdersCache(session);
      const offline = isApiNetworkError(error) || !(await isDeviceOnline());

      if (cached?.orders.length) {
        setOrders(cached.orders);
        setLastCheckedAt(cached.updatedAt ? new Date(cached.updatedAt) : new Date());
        if (offline) {
          showOfflineNotice();
        } else {
          setSyncMessage("Nao foi possivel atualizar agora. Mostrando ordens salvas no aparelho.");
        }
        return;
      }

      if (offline) {
        showOfflineNotice();
        return;
      }

      const errorMessage = error instanceof Error ? error.message : "Não foi possível carregar as ordens de serviço.";
      setMessageType("error");
      setMessage(errorMessage);
      setErrorModal(errorMessage);
    } finally {
      setOrdersLoading(false);
    }
  }

  async function loadServiceOrderDetails(orderId: string) {
    const session = readSavedSession();
    const idColaborador = getCollaboratorId(session);

    if (isTestSession(session) || !idColaborador) {
      return;
    }

    const currentOrder = orders.find((order) => order.id === orderId);
    const idOrdemServico = currentOrder?.apiOrderCode ?? currentOrder?.number.replace(/\D/g, "") ?? orderId;

    if (!(await isDeviceOnline())) {
      showOfflineNotice();
      return;
    }

    try {
      const freshOrder = await fetchServiceOrderDetails(idColaborador, idOrdemServico);

      if (!freshOrder) {
        return;
      }

      setOrders((current) =>
        current.map((order) =>
          order.id === orderId ? preserveStatusTimers([freshOrder], [order])[0] : order,
        ),
      );
      setLastCheckedAt(new Date());
    } catch (error) {
      if (isApiNetworkError(error) || !(await isDeviceOnline())) {
        showOfflineNotice();
        return;
      }

      const errorMessage =
        error instanceof Error ? error.message : "Não foi possível atualizar os dados da ordem de serviço.";
      setMessageType("error");
      setMessage(errorMessage);
      setErrorModal(errorMessage);
    }
  }

  async function queueAndTrySync(type: OfflineActionType, orderId: string, payload: unknown) {
    if (type === "finish_order") {
      const existingActions = await getPendingActions();
      await Promise.all(
        existingActions
          .filter((action) => action.type === "finish_order" && action.orderId === orderId)
          .map((action) => deletePendingAction(action.id)),
      );
    }

    const queuedAction = await enqueueOfflineAction(type, orderId, payload);
    setPendingSyncCount(await getPendingActionsCount());

    if (!(await isDeviceOnline())) {
      showOfflineNotice();
      return { offline: true, currentPending: true, error: "" };
    }

    const result = await syncPendingActions();
    const remainingActions = await getPendingActions();
    const currentPending = remainingActions.some((action) => action.id === queuedAction.id);
    setPendingSyncCount(remainingActions.length);
    if (result.offline) {
      showOfflineNotice();
      return { ...result, currentPending };
    }
    if (result.error) {
      setErrorModal(result.error);
    }
    setSyncMessage(result.missingUrl ? "Alteração salva. Configure a URL da API para sincronizar." : result.pending > 0 ? "Alteração salva. A sincronização será tentada novamente." : "Alteração sincronizada.");
    return { ...result, currentPending };
  }

  async function openPendingList() {
    const actions = await getPendingActions();
    setPendingActions(actions);
    setPendingSyncCount(actions.length);
    setShowPendingList(true);
  }

  async function removePending(actionId: string) {
    await deletePendingAction(actionId);
    const actions = await getPendingActions();
    setPendingActions(actions);
    setPendingSyncCount(actions.length);
    setSyncMessage("Pendência excluída.");
  }

  async function removeAllPending() {
    await clearPendingActions();
    setPendingActions([]);
    setPendingSyncCount(0);
    setShowPendingList(false);
    setSyncMessage("Todas as pendências foram excluídas.");
  }

  function updateOrderStatus(
    orderOrId: ServiceOrder | string,
    statusId: number,
    extraPayload: Record<string, unknown> = {},
    shouldQueue = true,
  ) {
    const statusStartedAt = new Date().toISOString();
    const orderId = typeof orderOrId === "string" ? orderOrId : orderOrId.id;
    const apiOrderCode =
      typeof orderOrId === "string"
        ? orderOrId
        : orderOrId.apiOrderCode ?? orderOrId.number.replace(/\D/g, "") ?? orderOrId.id;

    setOrders((current) =>
      current.map((order) =>
        order.id === orderId
          ? {
              ...order,
              statusId,
              status: serviceOrderStatuses[statusId],
              statusStartedAt,
            }
          : order,
      ),
    );

    if (shouldQueue && orderId !== testOrderId) {
      const idColaborador = getCollaboratorId(readSavedSession());

      void queueAndTrySync("status_change", orderId, {
        id_colaborador: idColaborador,
        observacao: typeof extraPayload.observacao === "string" ? extraPayload.observacao : "",
        id_ordem_servico: apiOrderCode,
        id_situacao_ordem_servico: statusId,
      });
    }
  }

  async function openClosingFlow() {
    const questions = await fetchClosingQuestions(selectedOrder ?? undefined);
    const savedDraft = localStorage.getItem(getClosingDraftKey(selectedOrder?.id ?? ""));
    const restoredDraft = await restoreClosingDraft(savedDraft, questions);

    setClosingQuestions(questions);
    setClosingAnswers(restoredDraft.answers);
    setClosingSubmitting(false);

    if (selectedOrder && savedDraft) {
      try {
        saveClosingDraft(selectedOrder.id, restoredDraft.answers);
      } catch {
        // The validated state remains available in memory for this session.
      }
    }

    if (restoredDraft.removedMedia > 0) {
      setSyncMessage(
        `${restoredDraft.removedMedia} mídia(s) antiga(s) não estavam mais no aparelho e foram removidas do rascunho. As outras respostas foram mantidas.`,
      );
    }
    setClosingStep(0);
    setClosingOrder(true);
  }

  function updateClosingAnswer(questionId: string, value: string | string[]) {
    setClosingAnswers((current) => {
      const next = {
        ...current,
        [questionId]: value,
      };

      if (selectedOrder) {
        try {
          saveClosingDraft(selectedOrder.id, next);
        } catch {
          setSyncMessage("Mídias carregadas. Rascunho grande será mantido nesta tela até finalizar.");
        }
      }

      return next;
    });
  }

  function closeClosingFlow() {
    if (closingSubmitting) {
      return;
    }

    releaseMediaPreviewUrls(closingAnswers);
    setClosingAnswers({});
    setClosingOrder(false);
    setClosingStep(0);
  }

  function prepareAnswersForPost() {
    return closingQuestions
      .filter((question) => !["observacao_servico", "responsavel", "assinatura"].includes(question.id))
      .map((question) => {
      const value = closingAnswers[question.id];
      const baseAnswer = {
        id_pergunta: question.apiQuestionId ?? question.id,
        pergunta: question.label,
        tipo_resposta: question.step,
        obrigatorio: question.required ? 1 : 2,
      };

      if (question.step === "checkbox") {
        const selectedIds = Array.isArray(value) ? value : [];
        const selectedAnswers = selectedIds.map((id) => ({
          id_resposta: id,
          resposta: question.options?.find((option) => option.id === id)?.label ?? "",
        }));

        return {
          ...baseAnswer,
          id_respostas: selectedIds,
          resposta: selectedAnswers.map((answer) => answer.resposta).join(", "),
          respostas: selectedAnswers,
        };
      }

      if (question.step === "radio") {
        const selectedId = String(value ?? "");

        return {
          ...baseAnswer,
          id_resposta: selectedId,
          id_respostas: selectedId ? [selectedId] : [],
          resposta: question.options?.find((option) => option.id === selectedId)?.label ?? "",
        };
      }

      if (question.step === "media") {
        const mediaList = Array.isArray(value) ? value : [];

        return {
          ...baseAnswer,
          midias: mediaList
            .map((item) => {
              const media = parseStoredMedia(item);

              if (!media) {
                return null;
              }

              const {
                previewUrl: _previewUrl,
                previewDataUrl: _previewDataUrl,
                status: _status,
                ...postMedia
              } = media;
              return {
                ...postMedia,
                id_pergunta: question.apiQuestionId ?? question.id,
                pergunta: question.label,
              };
            })
            .filter(Boolean),
          resposta: `${mediaList.length} mídia(s)`,
        };
      }

      if (question.step === "signature") {
        return {
          ...baseAnswer,
          assinatura: String(value ?? ""),
        };
      }

      return {
        ...baseAnswer,
        id_resposta: "",
        id_respostas: [],
        resposta: Array.isArray(value) ? value.join(", ") : String(value ?? ""),
      };
    });
  }

  async function validateMediaBeforeFinish(order: ServiceOrder) {
    const nextAnswers = { ...closingAnswers };
    let firstInvalidStep = -1;
    let removedMedia = 0;

    for (const [questionIndex, question] of closingQuestions.entries()) {
      if (question.step !== "media") {
        continue;
      }

      const current = Array.isArray(nextAnswers[question.id]) ? nextAnswers[question.id] as string[] : [];
      const valid: string[] = [];

      for (const item of current) {
        const media = parseStoredMedia(item);

        if (!media) {
          removedMedia += 1;
          continue;
        }

        try {
          const stored = await getMedia(media.id);

          if (!stored?.blob || stored.blob.size <= 0) {
            removedMedia += 1;
            continue;
          }

          valid.push(
            JSON.stringify({
              id: stored.id,
              name: stored.name || media.name,
              type: stored.type || media.type || inferMediaType(stored.name || media.name),
              size: stored.blob.size,
              createdAt: stored.createdAt || media.createdAt,
            } satisfies SavedMedia),
          );
        } catch {
          removedMedia += 1;
        }
      }

      nextAnswers[question.id] = valid;

      if (question.required && valid.length === 0) {
        firstInvalidStep = firstInvalidStep < 0 ? questionIndex : firstInvalidStep;
      }
    }

    if (removedMedia > 0) {
      releaseMediaPreviewUrls(closingAnswers);
      setClosingAnswers(nextAnswers);

      try {
        saveClosingDraft(order.id, nextAnswers);
      } catch {
        // The corrected state remains available in memory.
      }

      if (firstInvalidStep >= 0) {
        setClosingStep(firstInvalidStep);
      }

      setErrorModal(
        `${removedMedia} mídia(s) não estavam mais disponíveis no aparelho e foram retiradas. Adicione-as novamente antes de finalizar. As demais respostas continuam salvas.`,
      );
      return false;
    }

    return true;
  }

  async function finishOrder(order: ServiceOrder) {
    if (closingSubmitting) {
      return;
    }

    setClosingSubmitting(true);

    try {
      if (!(await validateMediaBeforeFinish(order))) {
        return;
      }

      const postAnswers = prepareAnswersForPost();
      const responsibleName = String(closingAnswers.responsavel ?? "");
      const serviceObservation = String(closingAnswers.observacao_servico ?? "");
      const signature = String(closingAnswers.assinatura ?? "");
      const idColaborador = getCollaboratorId(readSavedSession());
      const idOrdemServico = order.apiOrderCode ?? order.number.replace(/\D/g, "") ?? order.id;
      let queuedOffline = false;

      if (order.id !== testOrderId) {
        const syncResult = await queueAndTrySync("finish_order", order.id, {
          id_colaborador: idColaborador,
          id_ordem_servico: idOrdemServico,
          id_situacao_ordem_servico: 5,
          id_questionario: order.questionnaireId ?? "",
          observacao: serviceObservation,
          nome_responsavel: responsibleName,
          assinatura: signature,
          perguntas_respostas: postAnswers,
          ordem: {
            id: order.id,
            numero: order.number,
            id_ordem_servico: idOrdemServico,
            id_cliente: order.clientId ?? "",
            cliente: order.client,
            endereco: order.address,
            id_servico: order.serviceId ?? "",
            servico: order.service,
          },
          questionario: {
            id_questionario: order.questionnaireId ?? "",
            titulo: order.questionnaireTitle ?? "",
          },
          respostas: postAnswers,
        });

        if (!syncResult.offline && syncResult.currentPending) {
          return;
        }

        queuedOffline = syncResult.offline;
      }

      updateOrderStatus(order, 5, {}, false);
      localStorage.removeItem(getClosingDraftKey(order.id));
      releaseMediaPreviewUrls(closingAnswers);
      setClosingAnswers({});
      setClosingOrder(false);
      setClosingStep(0);
      setFinishQueuedOffline(queuedOffline);
      setFinishModal(true);
    } catch (error) {
      setErrorModal(
        error instanceof Error
          ? error.message
          : "Não foi possível preparar a finalização. O rascunho continua salvo.",
      );
    } finally {
      setClosingSubmitting(false);
    }
  }

  function confirmFinishedOrder() {
    setFinishModal(false);
    setFinishQueuedOffline(false);
    navigateTo("/ordens");
  }

  async function handleForgotPassword() {
    setResetLoading(true);
    setMessage("");

    const result = await requestPasswordReset(email.trim());

    setResetLoading(false);
    setMessage(result.message);
    setMessageType(result.ok ? "success" : "error");

    if (result.offline) {
      showOfflineNotice();
    }

    if (!result.ok && !result.offline) {
      setErrorModal(result.message);
    }
  }

  function handleLogout() {
    localStorage.removeItem(sessionKey);
    sessionStorage.removeItem(sessionKey);
    sessionStorage.removeItem("diffonso.authResponse");
    setIsLoggedIn(false);
    setOrders([]);
    setStatusFilter(null);
    setClosingOrder(false);
    setClosingSubmitting(false);
    setSuspendingOrder(false);
    setFinishModal(false);
    setFinishQueuedOffline(false);
    setClosingAnswers({});
    setClosingStep(0);
    setShowPendingList(false);
    setErrorModal("");
    setMessage("");
    window.scrollTo(0, 0);
    navigateTo("/login");
  }

  function handleSuspend(reason: string, order: ServiceOrder) {
    updateOrderStatus(order, 4, {}, false);
    if (order.id !== testOrderId) {
      void queueAndTrySync("status_change", order.id, {
        id_colaborador: getCollaboratorId(readSavedSession()),
        observacao: reason,
        id_ordem_servico: order.apiOrderCode ?? order.number.replace(/\D/g, "") ?? order.id,
        id_situacao_ordem_servico: 4,
      });
    }
    setSuspendingOrder(false);
  }

  function resetTestOrder() {
    setOrders((current) =>
      current.map((order) =>
        order.id === testOrderId
          ? {
              ...order,
              statusId: 1,
              status: serviceOrderStatuses[1],
              statusStartedAt: new Date().toISOString(),
            }
          : order,
      ),
    );
    localStorage.removeItem(getClosingDraftKey(testOrderId));
    setClosingOrder(false);
    setClosingSubmitting(false);
    setSuspendingOrder(false);
    setFinishModal(false);
    setFinishQueuedOffline(false);
    setSyncMessage("Ordem de teste reiniciada localmente.");
  }

  function renderLogin() {
    return (
      <main className="app-shell">
        <section className="login-screen" aria-label="Login Diffonso Climatização">
          <div className="brand-panel">
            <div className="brand-logo-frame">
              <img src="/logo-diffonso.png" alt="Diffonso Climatização" className="brand-logo" />
            </div>
          </div>

          <div className="form-heading">
            <span className="badge">
              <ShieldCheck size={25} />
              Acesso técnico
            </span>
            <h1>Entrar no aplicativo</h1>
            <p>Faça login para acessar suas ordens de serviço.</p>
          </div>

          <form className="login-form" onSubmit={handleSubmit}>
            <label className="field">
              <span>Email</span>
              <div className="field-control">
                <Mail size={21} />
                <input
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="tecnico@empresa.com"
                />
              </div>
            </label>

            <label className="field">
              <span>Senha</span>
              <div className="field-control">
                <LockKeyhole size={21} />
                <input
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Digite sua senha"
                />
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => setShowPassword((current) => !current)}
                  aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
                  title={showPassword ? "Ocultar senha" : "Mostrar senha"}
                >
                  {showPassword ? <EyeOff size={22} /> : <Eye size={22} />}
                </button>
              </div>
            </label>

            <div className="form-options">
              <label className="remember">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(event) => setRemember(event.target.checked)}
                />
                <span>Lembrar login e senha</span>
              </label>

              <button
                type="button"
                className="text-button"
                onClick={handleForgotPassword}
                disabled={resetLoading}
              >
                {resetLoading ? "Enviando..." : "Esqueceu a senha?"}
              </button>
            </div>

            {message && (
              <p className={`status-message ${messageType}`} role="status">
                {messageType === "success" && <CheckCircle2 size={18} />}
                {message}
              </p>
            )}

          <button type="submit" className="primary-button" disabled={loading}>
            <LogIn size={22} />
            {loading ? "Entrando..." : "Entrar"}
          </button>

          {errorModal && (
            <div className="modal-overlay" role="dialog" aria-modal="true">
              <div className="finished-modal error-modal">
                <X size={48} />
                <h2>Erro</h2>
                <p>{errorModal}</p>
                <button type="button" className="primary-button" onClick={() => setErrorModal("")}>
                  Entendi
                </button>
              </div>
            </div>
          )}
        </form>
      </section>
    </main>
    );
  }

  function renderOrders() {
    return (
      <main className="app-shell app-shell-orders">
        <section className="orders-screen" aria-label="Ordens de serviço">
          <header className="orders-header">
            <div className="orders-brand">
              <img src="/logo-diffonso.png" alt="Diffonso Climatização" />
            </div>
            <div>
              <span>Área técnica</span>
              <h1>Ordens de serviço</h1>
            </div>
            <button type="button" className="logout-button" onClick={handleLogout} aria-label="Sair" title="Sair">
              <LogOut size={20} />
            </button>
          </header>

          <button
            type="button"
            className="new-equipment-button"
            onClick={() => navigateTo("/equipamentos/novo")}
          >
            <span className="new-equipment-icon">
              <Wrench size={25} />
            </span>
            <span className="new-equipment-copy">
              <strong>Cadastrar equipamento</strong>
              <small>Novo equipamento para um cliente</small>
            </span>
            <ChevronRight size={25} />
          </button>

          <div className={`orders-toolbar ${pendingSyncCount > 0 ? "has-pending" : ""} ${statusFilter !== null ? "is-filtered" : ""}`}>
            <button
              type="button"
              className="orders-summary-button"
              onClick={() => setStatusFilter(null)}
              aria-label="Mostrar todas as ordens"
              title="Mostrar todas as ordens"
            >
              <span className="orders-total">
                <strong>{orders.length}</strong>
                <span>{orders.length === 1 ? "ordem carregada" : "ordens carregadas"}</span>
              </span>
              <span className="sync-info">
                <span className={isOnline === null ? "checking-dot" : isOnline ? "online-dot" : "offline-dot"}>
                  {isOnline === null ? "Verificando" : isOnline ? "Online" : "Offline"}
                </span>
                <span className="last-check">{formatLastCheck(lastCheckedAt)}</span>
              </span>
            </button>
            {pendingSyncCount > 0 && (
              <button type="button" className="pending-sync toolbar-pending" onClick={openPendingList}>
                {pendingSyncCount} pendente(s)
              </button>
            )}
          </div>

          <section className="orders-dashboard" aria-label="Resumo por situação">
            <div className="dashboard-statuses">
              {dashboardStatuses.map(({ id, label, icon: Icon }) => (
                <button
                  type="button"
                  className={`dashboard-status status-${id} ${statusFilter === id ? "active" : ""}`}
                  key={id}
                  onClick={() => setStatusFilter((current) => (current === id ? null : id))}
                  aria-pressed={statusFilter === id}
                >
                  <Icon size={17} />
                  <strong>{statusCounts[id]}</strong>
                  <AutoFitStatusLabel label={label} />
                </button>
              ))}
            </div>
            {statusFilter !== null && (
              <div className="active-status-filter" role="status">
                <span>Mostrando: {serviceOrderStatuses[statusFilter]}</span>
                <button type="button" onClick={() => setStatusFilter(null)} aria-label="Remover filtro">
                  <X size={14} />
                  Todas
                </button>
              </div>
            )}
          </section>

          {syncMessage && (
            <p className="sync-message">
              {isOnline ? <CheckCircle2 size={23} /> : <WifiOff size={23} />}
              <span>{syncMessage}</span>
              <ChevronRight size={22} />
            </p>
          )}

          {ordersLoading && <p className="orders-state">Carregando ordens de serviço...</p>}

          {!ordersLoading && orders.length === 0 && (
            <p className="orders-state">Nenhuma ordem de serviço encontrada para este usuário.</p>
          )}

          {!ordersLoading && orders.length > 0 && visibleOrders.length === 0 && (
            <p className="orders-state">Nenhuma ordem nesta situação.</p>
          )}

          <div className="orders-list">
            {visibleOrders.map((order) => (
              <article className="order-card" key={order.id}>
                <div className="order-card-top">
                  <span className="order-number">{order.number}</span>
                  <span className={`order-status status-${order.statusId}`}>
                    <Clock3 size={17} />
                    {order.status}
                  </span>
                </div>
                <div className="order-client">
                  <span className="client-icon"><UserRound size={27} /></span>
                  <h2>{order.client}</h2>
                </div>
                <p className="order-row">
                  <span className="row-icon"><MapPin size={23} /></span>
                  {order.address}
                </p>
                <p className="order-row">
                  <span className="row-icon"><Wrench size={23} /></span>
                  {order.service}
                </p>
                {order.scheduledAt && (
                  <p className="order-row">
                    <span className="row-icon"><CalendarDays size={23} /></span>
                    {order.scheduledAt}
                  </p>
                )}
                {shouldShowElapsedStatus(order.statusId) && (
                  <p className="elapsed-status">
                    {order.status} há {formatElapsedTime(order.statusStartedAt)}
                  </p>
                )}
                <button
                  type="button"
                  className="primary-button order-action"
                  onClick={() => navigateTo(`/ordem/${order.id}`)}
                >
                  <ClipboardList size={24} />
                  Abrir ordem de serviço
                  <ChevronRight size={26} />
                </button>
              </article>
            ))}
          </div>

          {errorModal && (
            <div className="modal-overlay" role="dialog" aria-modal="true">
              <div className="finished-modal error-modal">
                <X size={48} />
                <h2>Erro</h2>
                <p>{errorModal}</p>
                <button type="button" className="primary-button" onClick={() => setErrorModal("")}>
                  Entendi
                </button>
              </div>
            </div>
          )}

          {showPendingList && (
            <div className="modal-overlay" role="dialog" aria-modal="true">
              <section className="simple-modal pending-modal">
                <header className="closing-modal-header">
                  <div>
                    <span>Sincronização</span>
                    <h2>Pendências de envio</h2>
                  </div>
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => setShowPendingList(false)}
                    aria-label="Fechar"
                    title="Fechar"
                  >
                    <X size={22} />
                  </button>
                </header>

                <div className="pending-list">
                  {pendingActions.length === 0 ? (
                    <p className="orders-state">Nenhuma pendência salva.</p>
                  ) : (
                    pendingActions.map((action) => (
                      <article className="pending-item" key={action.id}>
                        <div>
                          <strong>OS {action.orderCode}</strong>
                          <span>{formatPendingType(action.type)}</span>
                          <small>
                            Tentativas: {action.attempts} | {new Date(action.createdAt).toLocaleString("pt-BR")}
                          </small>
                        </div>
                        <button type="button" onClick={() => void removePending(action.id)}>
                          Excluir
                        </button>
                      </article>
                    ))
                  )}
                </div>

                <footer className="closing-modal-footer">
                  <button type="button" className="stage-button secondary" onClick={() => setShowPendingList(false)}>
                    Voltar
                  </button>
                  <button
                    type="button"
                    className="stage-button danger"
                    disabled={pendingActions.length === 0}
                    onClick={removeAllPending}
                  >
                    Excluir todas
                  </button>
                </footer>
              </section>
            </div>
          )}
        </section>
      </main>
    );
  }

  function renderOrderDetail(order: ServiceOrder) {
    const canMove = ![2, 3, 5, 6].includes(order.statusId);
    const canStartService = ![3, 5, 6].includes(order.statusId);
    const canSuspend = [1, 2, 3].includes(order.statusId);

    return (
      <main className="app-shell app-shell-orders">
        <section className="order-detail-screen" aria-label="Detalhes da ordem de serviço">
          <header className="detail-header">
            <button
              type="button"
              className="back-button"
              onClick={() => {
                setClosingOrder(false);
                setSuspendingOrder(false);
                navigateTo("/ordens");
              }}
              aria-label="Voltar"
              title="Voltar"
            >
              <ArrowLeft size={22} />
            </button>
            <div>
              <span>Área técnica</span>
              <h1>Detalhes da ordem</h1>
            </div>
            <button type="button" className="logout-button detail-logout" onClick={handleLogout} aria-label="Sair" title="Sair">
              <LogOut size={20} />
            </button>
          </header>

          <article className="detail-card">
            <div className="detail-card-top">
              <span className="order-number">{order.number}</span>
              <span className={`order-status status-${order.statusId}`}>
                <Clock3 size={17} />
                {order.status}
              </span>
            </div>
            <div className="order-client">
              <span className="client-icon"><UserRound size={27} /></span>
              <h2>{order.client}</h2>
            </div>
            <p className="order-row">
              <span className="row-icon"><MapPin size={23} /></span>
              {order.address}
            </p>
            {order.scheduledAt && (
              <p className="order-row">
                <span className="row-icon"><CalendarDays size={23} /></span>
                {order.scheduledAt}
              </p>
            )}
            <p className="order-row">
              <span className="row-icon"><Wrench size={23} /></span>
              {order.service}
            </p>
            {shouldShowElapsedStatus(order.statusId) && (
              <p className="elapsed-status">
                {order.status} há {formatElapsedTime(order.statusStartedAt)}
              </p>
            )}
          </article>

          <div className="action-grid">
            <button
              type="button"
              className={`stage-button move ${order.statusId === 2 ? "muted" : ""}`}
              disabled={!canMove}
              onClick={() => updateOrderStatus(order, 2)}
            >
              <Navigation size={21} />
              {order.statusId === 2 ? "Em deslocamento" : "Iniciar deslocamento"}
            </button>
            <button
              type="button"
              className={`stage-button attend ${order.statusId === 3 ? "muted" : ""}`}
              disabled={!canStartService}
              onClick={() => updateOrderStatus(order, 3)}
            >
              <Play size={21} />
              {order.statusId === 3 ? "Atendimento iniciado" : "Iniciar atendimento"}
            </button>
            {canSuspend && (
              <button
                type="button"
                className="stage-button secondary"
                onClick={() => setSuspendingOrder(true)}
              >
                <PauseCircle size={21} />
                Suspender
              </button>
            )}
            {order.statusId === 3 && (
              <button type="button" className="stage-button finish" onClick={openClosingFlow}>
                <Flag size={21} />
                Encerrar atendimento
              </button>
            )}
            {order.id === testOrderId && (
              <button type="button" className="stage-button test-reset" onClick={resetTestOrder}>
                Reiniciar ordem de teste
              </button>
            )}
            <button
              type="button"
              className="stage-button equipment-detail-action"
              onClick={() => {
                const query = new URLSearchParams({
                  origemOrdem: order.id,
                  clienteNome: order.client,
                });

                if (order.clientId) {
                  query.set("clienteId", order.clientId);
                }

                navigateTo(`/equipamentos/novo?${query.toString()}`);
              }}
            >
              <Wrench size={21} />
              Cadastrar equipamento
            </button>
          </div>

          {suspendingOrder && (
            <SuspendModal onCancel={() => setSuspendingOrder(false)} onConfirm={(reason) => handleSuspend(reason, order)} />
          )}

          {closingOrder && (
            <ClosingModal
              answers={closingAnswers}
              currentStep={closingStep}
              onAnswer={updateClosingAnswer}
              onBack={() => setClosingStep((current) => Math.max(0, current - 1))}
              onClose={closeClosingFlow}
              onFinish={() => finishOrder(order)}
              onNext={() => setClosingStep((current) => Math.min(closingQuestions.length - 1, current + 1))}
              questions={closingQuestions}
              submitting={closingSubmitting}
            />
          )}

          {finishModal && (
            <div className="modal-overlay" role="dialog" aria-modal="true">
              <div className="finished-modal">
                <CheckCircle2 size={58} />
                <h2>{finishQueuedOffline ? "Finalização salva" : "Ordem finalizada"}</h2>
                <p>
                  {finishQueuedOffline
                    ? "Sem internet no momento. O envio para a API será feito automaticamente ao reconectar."
                    : "Atendimento encerrado e enviado com sucesso."}
                </p>
                <button type="button" className="primary-button" onClick={confirmFinishedOrder}>
                  Voltar para ordens
                </button>
              </div>
            </div>
          )}

          {errorModal && (
            <div className="modal-overlay" role="dialog" aria-modal="true">
              <div className="finished-modal error-modal">
                <X size={48} />
                <h2>Erro</h2>
                <p>{errorModal}</p>
                <button type="button" className="primary-button" onClick={() => setErrorModal("")}>
                  Entendi
                </button>
              </div>
            </div>
          )}
        </section>
      </main>
    );
  }

  if (!isLoggedIn || route.page === "login") {
    return renderLogin();
  }

  if (route.page === "equipment-registration") {
    const session = readSavedSession();
    const query = new URLSearchParams(window.location.search);
    const sourceOrderId = query.get("origemOrdem") ?? "";

    return (
      <EquipmentRegistrationScreen
        collaboratorId={getCollaboratorId(session)}
        initialClientId={query.get("clienteId") ?? ""}
        initialClientName={query.get("clienteNome") ?? ""}
        isTestMode={isTestSession(session)}
        onBack={() => navigateTo(sourceOrderId ? `/ordem/${sourceOrderId}` : "/ordens")}
      />
    );
  }

  if (route.page === "order") {
    return selectedOrder ? renderOrderDetail(selectedOrder) : renderOrders();
  }

  return renderOrders();
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);
