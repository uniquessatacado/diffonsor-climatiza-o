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
  fetchServiceOrderDetailOrders,
  fetchServiceOrders,
  getTestServiceOrders,
  normalizeCachedServiceOrders,
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
import {
  getEquipmentGroupId,
  groupServiceOrders,
  type ServiceOrderGroup,
} from "./services/serviceOrderGroups";
import { EquipmentRegistrationScreen } from "./components/EquipmentRegistrationScreen";
import { BrazilianDateInput } from "./components/BrazilianDateInput";
import { formatBrazilianDate, formatBrazilianDateTime } from "./services/dateFormat";
import { getOrderDetailsPath, getOrderEntryPath, routeFromPath } from "./services/orderNavigation";
import {
  readClosingDraft,
  writeClosingDraft,
  removeClosingDraft,
  mergeClosingAnswers,
  mergeMediaAnswers,
  readBackendClosingAnswers,
  getClosingDraftKey as getScopedClosingDraftKey,
  createClosingDraftSnapshot,
  getClosingMediaIdentityKeys,
  type ClosingDraft,
  type ClosingDraftScope,
} from "./services/closingDrafts";
import "./styles.css";

const rememberedLoginKey = "diffonso.rememberedLogin";
const sessionKey = "diffonso.session";
const ordersCacheKey = "diffonso.cachedOrders";
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

  return `Última verificação ${formatBrazilianDate(date)} às ${date.toLocaleTimeString("pt-BR", {
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

function mergeOrderSummaries(freshOrders: ServiceOrder[], previousOrders: ServiceOrder[], pending: PendingActionSummary[]) {
  const previousById = new Map(previousOrders.map((order) => [order.id, order]));
  const incomingOrders = freshOrders.flatMap((summary) => {
    const raw = summary.raw && typeof summary.raw === "object" ? summary.raw as Record<string, unknown> : {};
    const omitsEquipment = !Object.prototype.hasOwnProperty.call(raw, "equipamentos") && !Object.prototype.hasOwnProperty.call(raw, "equipamento");
    const detailedItems = !summary.detailsLoaded && !summary.equipment && omitsEquipment
      ? previousOrders.filter((previous) => previous.detailsLoaded && previous.equipment && previous.apiOrderCode === summary.apiOrderCode)
      : [];
    return detailedItems.length
      ? detailedItems.map((previous) => ({ ...previous, client: summary.client, clientId: summary.clientId, address: summary.address }))
      : [summary];
  });
  return preserveStatusTimers(incomingOrders.map((summary) => {
    const previous = previousById.get(summary.id);
    const sameEquipment = Boolean(summary.equipment) === Boolean(previous?.equipment)
      && summary.equipmentOrderId === previous?.equipmentOrderId
      && summary.equipment?.clientEquipmentId === previous?.equipment?.clientEquipmentId;
    const sameQuestionnaire = !summary.questionnaireId || summary.questionnaireId === previous?.questionnaireId;
    // A list refresh is not a detailed questionnaire response.
    const order = !summary.detailsLoaded && previous?.detailsLoaded && sameEquipment && sameQuestionnaire
      ? { ...summary, equipment: previous.equipment, service: previous.service, serviceId: previous.serviceId,
          questionnaireId: previous.questionnaireId, questionnaireTitle: previous.questionnaireTitle,
          closingQuestions: previous.closingQuestions, questionnaireResponses: previous.questionnaireResponses,
          questionnaireSource: previous.questionnaireSource, questionnaireResolved: true, detailsLoaded: true }
      : summary;
    const action = pending.filter((item) => item.orderId === order.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-1)[0];
    return action?.statusId
      ? { ...order, statusId: action.statusId, status: serviceOrderStatuses[action.statusId], statusStartedAt: previous?.statusStartedAt ?? action.createdAt }
      : order;
  }), previousOrders);
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

function getDraftScope(order: ServiceOrder): ClosingDraftScope {
  const session = readSavedSession();
  return {
    userId: isTestSession(session) ? "teste" : String(getCollaboratorId(session) || session?.email || "anonimo"),
    orderId: order.apiId ?? order.apiOrderCode,
    equipmentOrderId: order.equipmentOrderId ?? (order.equipment ? `equipment-${order.id}` : undefined),
    questionnaireId: order.questionnaireId,
  };
}

type ClosingContext = { order: ServiceOrder; scope: ClosingDraftScope; key: string };

async function readOrdersCache(session?: SavedSession | null) {
  const key = getOrdersCacheKey(session);

  try {
    const cachedDb = await readCachedOrders<ServiceOrder>(key);

    if (cachedDb?.orders.length) {
      return { ...cachedDb, orders: normalizeCachedServiceOrders(cachedDb.orders) };
    }
  } catch {
    // LocalStorage fallback keeps older caches readable.
  }

  try {
    const cachedLocal = localStorage.getItem(key);

    if (cachedLocal) {
      return {
        orders: normalizeCachedServiceOrders(JSON.parse(cachedLocal) as ServiceOrder[]),
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
  source?: "remote";
  url?: string;
  remotePayload?: Record<string, unknown>;
};

function inferMediaType(name: string) {
  const extension = name.split(/[?#]/)[0].split(".").pop()?.toLowerCase() ?? "";

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
  const remoteUrl = [record.url, record.uri].find((item): item is string => typeof item === "string" && /^https?:\/\//i.test(item));
  const id = String(record.id ?? record.id_midia ?? remoteUrl ?? "").trim();
  const name = String(record.name || record.nome || "midia");
  const size = Number(record.size ?? record.tamanho ?? (remoteUrl ? 0 : NaN));

  if (!id || !Number.isFinite(size) || size < 0) {
    return null;
  }

  return {
    id,
    name,
    type: typeof record.type === "string" && record.type.trim() ? record.type
      : typeof record.tipo === "string" && record.tipo.trim() ? record.tipo : inferMediaType(remoteUrl || name),
    size,
    createdAt:
      typeof record.createdAt === "string" && record.createdAt
        ? record.createdAt
        : new Date(0).toISOString(),
    ...(remoteUrl ? { source: "remote" as const, url: remoteUrl,
      remotePayload: record.remotePayload && typeof record.remotePayload === "object"
        ? record.remotePayload as Record<string, unknown> : record } : {}),
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

function readLegacyClosingDraft(orderId: string): Record<string, string | string[]> | null {
  try {
    const saved = localStorage.getItem(getClosingDraftKey(orderId));
    if (!saved) return null;
    const parsed: unknown = JSON.parse(saved);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) =>
      typeof value === "string" || (Array.isArray(value) && value.every((item) => typeof item === "string")),
    ));
  } catch {
    // Preserve the original legacy record if it cannot be read.
    return null;
  }
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
    if (!media?.id || media.previewUrl || media.source === "remote") {
      return;
    }

    let objectUrl = "";
    let disposed = false;

    void getMedia(media.id).then((stored) => {
      if (!stored || disposed) {
        return;
      }

      objectUrl = URL.createObjectURL(stored.blob);
      setRestoredPreviewUrl(objectUrl);
    }).catch(() => { if (!disposed) setPreviewFailed(true); });

    return () => {
      disposed = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [media?.id, media?.previewUrl]);

  if (!media) {
    return null;
  }

  const previewSource = media.url || media.previewUrl || restoredPreviewUrl || media.previewDataUrl;
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
  onAnswer: (questionId: string, value: string | string[], append?: boolean) => void;
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
    let preparedFiles: File[];
    try {
      preparedFiles = await Promise.all(candidates.map((file) => optimizeImageForUpload(file)));
    } catch {
      setMediaError("Não foi possível preparar esta mídia. As fotos anteriores continuam salvas.");
      setPreparingMedia(false);
      return;
    }
    const tooLargeAfterOptimization = preparedFiles.filter((file) => file.size > maxMediaBytes);
    const current = Array.isArray(answerRef.current) ? answerRef.current : [];
    const currentBytes = Object.entries(answers).reduce((total, [answerId, storedAnswer]) => {
      const mediaItems =
        answerId === question.id
          ? current
          : Array.isArray(storedAnswer)
            ? storedAnswer
            : [];

      return total + mediaItems.reduce((subtotal, item) => {
        const media = parseStoredMedia(item);
        return subtotal + (media?.source === "remote" ? 0 : media?.size ?? 0);
      }, 0);
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
      const nextMedia = prepared.map(({ metadata }) =>
        JSON.stringify({
          ...metadata,
          status: "ready",
        } satisfies MediaAnswer),
      );
      const next = mergeMediaAnswers(latest, nextMedia);

      answerRef.current = next;
      onAnswer(question.id, nextMedia, true);
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

    // Keep the blob while an offline report may still reference it. The draft
    // records the explicit removal, so navigation cannot bring the photo back.

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
            <button type="button" className="icon-button" onClick={onClose} disabled={submitting || preparingMedia} aria-label="Fechar" title="Fechar">
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
            <BrazilianDateInput
              key={question.id}
              className="large-input"
              ariaLabel={question.label}
              required={question.required}
              value={String(answer ?? "")}
              onChange={(value) => onAnswer(question.id, value)}
            />
          )}

          {question.step === "datetime" && (
            <div className="datetime-fields">
              <BrazilianDateInput
                key={question.id}
                className="large-input"
                ariaLabel={question.label}
                required={question.required}
                value={parseDatetimeAnswer(answer).date}
                onChange={(value) =>
                  onAnswer(question.id, `${value}|${parseDatetimeAnswer(answer).time}`)
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
                      key={getClosingMediaIdentityKeys(item).join("|") || item}
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
  const hasStrokeRef = useRef(false);
  const lastPointRef = useRef({ x: 0, y: 0 });
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
    hasStrokeRef.current = false;
    canvas.setPointerCapture(event.pointerId);
    const point = getPoint(event);
    lastPointRef.current = point;
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
    if (point.x === lastPointRef.current.x && point.y === lastPointRef.current.y) return;
    lastPointRef.current = point;
    hasStrokeRef.current = true;
    context.lineTo(point.x, point.y);
    context.stroke();
  }

  function stopDrawing() {
    if (!drawingRef.current) {
      return;
    }

    drawingRef.current = false;
    const canvas = canvasRef.current;

    if (canvas && hasStrokeRef.current) {
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
  const [openingOrderId, setOpeningOrderId] = useState<string | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState("");
  const [resolvedDetailRoute, setResolvedDetailRoute] = useState<string | null>(null);
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
  const [closingLoading, setClosingLoading] = useState(false);
  const [closingContext, setClosingContext] = useState<ClosingContext | null>(null);
  const activeClosingContext = useRef<ClosingContext | null>(null);
  activeClosingContext.current = closingOrder ? closingContext : null;
  const closingDraftsByScope = useRef(new Map<string, ClosingDraft>());
  const detailRequests = useRef(new Map<string, Promise<ServiceOrder[]>>());
  const preparedDetailRoute = useRef<string | null>(null);
  const activeRoute = useRef(route);
  activeRoute.current = route;
  const ordersRef = useRef(orders);
  ordersRef.current = orders;
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
  const orderGroups = useMemo(
    () => groupServiceOrders(orders, serviceOrderStatuses),
    [orders],
  );
  const homeOrderGroups = useMemo(
    () => orderGroups.filter((group) => !group.isEquipmentBased || group.representative.statusId !== 5),
    [orderGroups],
  );
  const selectedOrderGroup = useMemo(
    () => orderGroups.find((group) => group.id === route.orderId) ?? null,
    [orderGroups, route.orderId],
  );
  const statusCounts = useMemo(
    () =>
      Object.fromEntries(
        dashboardStatuses.map(({ id }) => [
          id,
          homeOrderGroups.filter((group) => group.representative.statusId === id).length,
        ]),
      ) as Record<number, number>,
    [homeOrderGroups],
  );
  const visibleOrderGroups = useMemo(
    () =>
      statusFilter === null
        ? homeOrderGroups
        : homeOrderGroups.filter((group) => group.representative.statusId === statusFilter),
    [homeOrderGroups, statusFilter],
  );
  const canSubmit = useMemo(() => email.trim() !== "" && password.trim() !== "", [email, password]);

  function showOfflineNotice() {
    setIsOnline(false);
    setSyncMessage(offlineNotice);
  }

  useEffect(() => {
    function handleRouteChange() {
      setRoute(routeFromPath(window.location.pathname));
    }

    window.addEventListener("popstate", handleRouteChange);
    return () => window.removeEventListener("popstate", handleRouteChange);
  }, []);

  useEffect(() => {
    window.scrollTo(0, 0);
    setClosingOrder(false);
    setClosingContext(null);
    setSuspendingOrder(false);
  }, [route.page, route.orderId, route.overview]);

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
      if (cached?.orders.length && getOrdersCacheKey(readSavedSession()) === getOrdersCacheKey(session)) {
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

    async function trySync(showErrors = true) {
      const result = await syncPendingActions();
      setPendingSyncCount(result.pending);

      if (result.offline) {
        showOfflineNotice();
        return result;
      }

      if (result.error) {
        if (showErrors) {
          setErrorModal(result.error);
        }
        setSyncMessage("Há relatório(s) pendente(s). O aplicativo tentará enviar novamente.");
      }

      if (result.synced > 0) {
        setSyncMessage(`${result.synced} alteração(ões) sincronizada(s).`);
      } else if (result.missingUrl && result.pending > 0) {
        setSyncMessage("Pendências salvas. Configure a URL da API para sincronizar.");
      }

      return result;
    }

    async function retryPendingSync() {
      if ((await getPendingActionsCount()) === 0 || !(await isDeviceOnline())) {
        return;
      }

      const result = await trySync(false);

      if (result.synced > 0) {
        await loadServiceOrders();
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

    function handleAppResume() {
      if (document.visibilityState === "visible") {
        void retryPendingSync();
      }
    }

    window.addEventListener("focus", handleAppResume);
    document.addEventListener("visibilitychange", handleAppResume);
    const retryTimer = window.setInterval(() => void retryPendingSync(), 30000);

    void (async () => {
      await setupOfflineSync();
      removeNetworkListener = await addNetworkListener(handleConnectivityChange);
      const connected = await isDeviceOnline();

      if (connected) {
        setIsOnline(true);
      } else {
        showOfflineNotice();
      }

      setPendingSyncCount(await getPendingActionsCount());
      if (connected) {
        await trySync();
      }
    })();

    return () => {
      window.clearInterval(retryTimer);
      window.removeEventListener("focus", handleAppResume);
      document.removeEventListener("visibilitychange", handleAppResume);
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

    if (isLoggedIn && (route.page === "orders" || (route.page === "order" && orders.length === 0))) {
      void loadServiceOrders();
    }
  }, [isLoggedIn, route.page]);

  useEffect(() => {
    if (!isLoggedIn || route.page !== "order" || !route.orderId || (!selectedOrder && !selectedOrderGroup)) {
      return;
    }

    let cancelled = false;
    const routeId = route.orderId;
    if (preparedDetailRoute.current === routeId) {
      preparedDetailRoute.current = null;
      setResolvedDetailRoute(routeId);
      setDetailsLoading(false);
      setDetailsError("");
      return;
    }
    setDetailsLoading(true);
    setResolvedDetailRoute(null);
    setDetailsError("");
    void loadServiceOrderDetails(routeId).then((result) => {
      if (!cancelled) {
        setResolvedDetailRoute(result ? routeId : null);
      }
    }).catch((error: unknown) => {
      if (!cancelled) setDetailsError(error instanceof Error ? error.message : "Não foi possível carregar os detalhes.");
    }).finally(() => {
      if (!cancelled) setDetailsLoading(false);
    });
    return () => { cancelled = true; };
  }, [isLoggedIn, route.page, route.orderId, selectedOrder?.apiOrderCode, selectedOrderGroup?.representative.apiOrderCode]);

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
      const pending = await getPendingActions();
      if (getOrdersCacheKey(readSavedSession()) !== getOrdersCacheKey(session)) return;

      setOrders((current) => mergeOrderSummaries(serviceOrders, current.length ? current : (cached?.orders ?? []), pending));
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
    const currentOrders = ordersRef.current;
    const currentOrder = currentOrders.find((order) => order.id === orderId)
      ?? groupServiceOrders(currentOrders, serviceOrderStatuses).find((group) => group.id === orderId)?.representative;
    if (!currentOrder) return null;
    if (isTestSession(session)) return [currentOrder];
    if (!idColaborador) return null;
    const idOrdemServico = currentOrder.apiOrderCode;
    const cachedDetails = currentOrders.filter((order) => order.apiOrderCode === idOrdemServico && order.detailsLoaded);
    const useOfflineDetails = () => {
      showOfflineNotice();
      const requiredOrders = currentOrders.filter((order) => order.apiOrderCode === idOrdemServico && (orderId !== currentOrder.id || order.id === orderId));
      if (requiredOrders.length && requiredOrders.every((order) => cachedDetails.some((cached) => cached.id === order.id))) return cachedDetails;
      throw new Error("Conecte-se à internet para carregar os detalhes desta ordem pela primeira vez. Os rascunhos existentes continuam salvos.");
    };
    if (!(await isDeviceOnline())) return useOfflineDetails();
    const requestKey = `${idColaborador}:${idOrdemServico}`;
    let request = detailRequests.current.get(requestKey);
    if (!request) {
      request = fetchServiceOrderDetailOrders(idColaborador, idOrdemServico);
      detailRequests.current.set(requestKey, request);
    }
    try {
      const freshOrders = await request;
      if (!freshOrders.length) throw new Error("A API não retornou os detalhes desta ordem.");
      if (getCollaboratorId(readSavedSession()) !== idColaborador) return null;
      const pending = await getPendingActions();
      const detailedOrders = mergeOrderSummaries(freshOrders, ordersRef.current, pending);
      setOrders((current) => [
        ...current.filter((order) => order.apiOrderCode !== idOrdemServico),
        ...detailedOrders,
      ]);
      setLastCheckedAt(new Date());
      if (activeRoute.current.orderId === orderId && !detailedOrders.some((order) => order.id === orderId)) {
        const group = groupServiceOrders(detailedOrders, serviceOrderStatuses)[0];
        if (group && group.id !== orderId) {
          navigateTo(activeRoute.current.overview && group.isEquipmentBased ? getOrderDetailsPath(group) : getOrderEntryPath(group));
        }
      }
      return detailedOrders;
    } catch (error) {
      if (isApiNetworkError(error) || !(await isDeviceOnline())) return useOfflineDetails();
      throw error;
    } finally {
      if (detailRequests.current.get(requestKey) === request) detailRequests.current.delete(requestKey);
    }
  }

  async function openServiceOrder(group: ServiceOrderGroup<ServiceOrder>) {
    if (openingOrderId) return;
    setOpeningOrderId(group.id);
    try {
      const details = await loadServiceOrderDetails(group.id);
      if (!details?.length || activeRoute.current.page !== "orders") return;
      const resolvedGroup = groupServiceOrders(details, serviceOrderStatuses)[0];
      if (!resolvedGroup) return;
      const path = getOrderEntryPath(resolvedGroup);
      const routeId = routeFromPath(path).orderId;
      preparedDetailRoute.current = routeId;
      setResolvedDetailRoute(routeId);
      navigateTo(path);
    } catch (error) {
      setErrorModal(error instanceof Error ? error.message : "Não foi possível carregar os detalhes desta ordem.");
    } finally {
      setOpeningOrderId(null);
    }
  }

  async function queueAndTrySync(type: OfflineActionType, orderId: string, payload: unknown, draftKey?: string) {
    if (type === "finish_order") {
      const existingActions = await getPendingActions();
      await Promise.all(
        existingActions
          .filter((action) => action.type === "finish_order" && action.orderId === orderId)
          .map((action) => deletePendingAction(action.id)),
      );
    }

    const queuedAction = await enqueueOfflineAction(type, orderId, payload, { draftKey });
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
        ...(typeof orderOrId !== "string" && orderOrId.equipmentOrderId
          ? { id_ordem_servico_equipamento: orderOrId.equipmentOrderId }
          : {}),
      });
    }
  }

  async function openClosingFlow() {
    if (!selectedOrder || closingLoading) return;
    const requestedOrderId = selectedOrder.id;
    setClosingLoading(true);
    try {
      const detailedOrders = await loadServiceOrderDetails(requestedOrderId);
      const order = detailedOrders?.find((item) => item.id === requestedOrderId);
      if (!order || activeRoute.current.orderId !== requestedOrderId) return;
      const questions = await fetchClosingQuestions(order);
      const scope = getDraftScope(order);
      const key = getScopedClosingDraftKey(scope);
      let draft = closingDraftsByScope.current.get(key) ?? await readClosingDraft(scope);
      if (!draft) {
        const legacy = readLegacyClosingDraft(order.id);
        if (legacy) {
          draft = await writeClosingDraft(scope, legacy);
          localStorage.removeItem(getClosingDraftKey(order.id));
        }
      }
      const backendAnswers = readBackendClosingAnswers(order.questionnaireResponses, questions);
      const answers = mergeClosingAnswers(questions, backendAnswers, draft);
      const snapshot = await writeClosingDraft(scope, answers);
      if (activeRoute.current.orderId !== requestedOrderId) return;
      closingDraftsByScope.current.set(key, snapshot);
      setClosingContext({ order, scope, key });
      setClosingQuestions(questions);
      setClosingAnswers(answers);
      setClosingSubmitting(false);
      setClosingStep(0);
      setClosingOrder(true);
    } catch (error) {
      setErrorModal(error instanceof Error ? error.message : "Não foi possível abrir o rascunho. As respostas existentes foram preservadas.");
    } finally {
      setClosingLoading(false);
    }
  }

  async function updateClosingAnswer(questionId: string, value: string | string[], context: ClosingContext, append = false) {
    const previous = closingDraftsByScope.current.get(context.key) ?? null;
    const previousAnswer = previous?.answers[questionId];
    const next = { ...previous?.answers, [questionId]: append && Array.isArray(value)
      ? mergeMediaAnswers(Array.isArray(previousAnswer) ? previousAnswer : [], value) : value };
    closingDraftsByScope.current.set(context.key, createClosingDraftSnapshot(next, previous));
    // An async photo preparation remains bound to the order where it started.
    if (activeRoute.current.orderId === context.order.id && activeClosingContext.current?.key === context.key) setClosingAnswers(next);
    try {
      await writeClosingDraft(context.scope, next);
    } catch {
      setErrorModal("Não foi possível guardar o rascunho no aparelho. As respostas continuam nesta sessão; tente novamente antes de sair do aplicativo.");
    }
  }

  async function closeClosingFlow() {
    if (closingSubmitting || !closingContext) return;
    try {
      const answers = closingDraftsByScope.current.get(closingContext.key)?.answers ?? closingAnswers;
      await writeClosingDraft(closingContext.scope, answers);
      releaseMediaPreviewUrls(closingAnswers);
      setClosingOrder(false);
      setClosingStep(0);
    } catch {
      setErrorModal("Não foi possível guardar o rascunho. Tente novamente antes de fechar o atendimento.");
    }
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
                ...(media.source === "remote" ? media.remotePayload : postMedia),
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

  async function validateMediaBeforeFinish() {
    for (const [index, question] of closingQuestions.entries()) {
      if (question.step !== "media") continue;
      const value = closingAnswers[question.id];
      for (const item of Array.isArray(value) ? value : []) {
        const media = parseStoredMedia(item);
        if (media?.source === "remote") continue;
        const stored = media ? await getMedia(media.id) : null;
        if (!stored?.blob || stored.blob.size <= 0) {
          setClosingStep(index);
          setErrorModal("Não foi possível ler uma mídia deste atendimento. O rascunho foi preservado. Tente novamente ou remova explicitamente o arquivo indisponível e adicione-o de novo.");
          return false;
        }
      }
    }
    return true;
  }

  async function finishOrder(order: ServiceOrder) {
    if (closingSubmitting || !closingContext || closingContext.order.id !== order.id) {
      return;
    }

    const invalidIndex = closingQuestions.findIndex((question) => question.required && !isQuestionAnswered(question, closingAnswers[question.id]));
    if (invalidIndex >= 0 || !String(closingAnswers.assinatura ?? "").startsWith("data:image/") || !String(closingAnswers.responsavel ?? "").trim()) {
      setClosingStep(invalidIndex >= 0 ? invalidIndex : Math.max(0, closingQuestions.findIndex((question) => question.step === "signature")));
      setErrorModal("Preencha os campos obrigatórios e a assinatura do responsável antes de finalizar.");
      return;
    }

    setClosingSubmitting(true);

    try {
      if (!(await validateMediaBeforeFinish())) {
        return;
      }
      await writeClosingDraft(closingContext.scope, closingAnswers);

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
          ...(order.equipmentOrderId
            ? { id_ordem_servico_equipamento: order.equipmentOrderId }
            : {}),
          ...(Object.prototype.hasOwnProperty.call(order, "originPmoc")
            ? { origem_pmoc: order.originPmoc }
            : {}),
          ...(Object.prototype.hasOwnProperty.call(order, "activitiesPmoc")
            ? { atividades_pmoc: order.activitiesPmoc }
            : {}),
          id_questionario: order.questionnaireId ?? "",
          observacao: serviceObservation,
          nome_responsavel: responsibleName,
          assinatura: signature,
          perguntas_respostas: postAnswers,
          ordem: {
            id: order.apiId ?? order.id,
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
        }, closingContext.key);

        if (!syncResult.offline && syncResult.currentPending) {
          return;
        }

        queuedOffline = syncResult.offline;
      }

      updateOrderStatus(order, 5, {}, false);
      if (!queuedOffline) {
        await removeClosingDraft(closingContext.scope);
      }
      closingDraftsByScope.current.delete(closingContext.key);
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
        ...(order.equipmentOrderId
          ? { id_ordem_servico_equipamento: order.equipmentOrderId }
          : {}),
      });
    }
    setSuspendingOrder(false);
  }

  async function resetTestOrder() {
    const testOrder = orders.find((order) => order.id === testOrderId);
    if (testOrder) {
      const scope = getDraftScope(testOrder);
      try {
        await removeClosingDraft(scope);
        closingDraftsByScope.current.delete(getScopedClosingDraftKey(scope));
      } catch {
        setErrorModal("Não foi possível reiniciar o rascunho da ordem de teste.");
        return;
      }
    }
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
                <strong>{homeOrderGroups.length}</strong>
                <span>{homeOrderGroups.length === 1 ? "ordem carregada" : "ordens carregadas"}</span>
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

          {!ordersLoading && homeOrderGroups.length === 0 && (
            <p className="orders-state">Nenhuma ordem de serviço encontrada para este usuário.</p>
          )}

          {!ordersLoading && homeOrderGroups.length > 0 && visibleOrderGroups.length === 0 && (
            <p className="orders-state">Nenhuma ordem nesta situação.</p>
          )}

          <div className="orders-list">
            {visibleOrderGroups.map((group) => {
              const order = group.representative;

              return (
              <article className="order-card" key={group.id}>
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
                    {formatBrazilianDateTime(order.scheduledAt, { fallback: order.scheduledAt === "Hoje" ? "Hoje" : "Não informado" })}
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
                  disabled={openingOrderId !== null}
                  onClick={() => void openServiceOrder(group)}
                >
                  <ClipboardList size={24} />
                  {openingOrderId === group.id ? "Carregando ordem..." : "Abrir ordem de serviço"}
                  <ChevronRight size={26} />
                </button>
              </article>
              );
            })}
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
                            Tentativas: {action.attempts} | {formatBrazilianDateTime(action.createdAt, { includeSeconds: true })}
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

  function renderOrderDetail(order: ServiceOrder, overviewGroup?: ServiceOrderGroup<ServiceOrder>) {
    const canMove = !overviewGroup && ![2, 3, 5, 6].includes(order.statusId);
    const canStartService = !overviewGroup && ![3, 5, 6].includes(order.statusId);
    const canSuspend = [1, 2, 3].includes(order.statusId);
    const parentEquipmentGroup = orderGroups.find((group) => group.isEquipmentBased && group.orders.some((item) => item.id === order.id));

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
                navigateTo(parentEquipmentGroup ? `/ordem/${parentEquipmentGroup.id}` : "/ordens");
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
                {formatBrazilianDateTime(order.scheduledAt, { fallback: order.scheduledAt === "Hoje" ? "Hoje" : "Não informado" })}
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

          {overviewGroup && (
            <article className="detail-card">
              <label htmlFor="order-equipment-target">Equipamento do atendimento</label>
              <select id="order-equipment-target" className="large-input" value="" onChange={(event) => {
                if (event.target.value) navigateTo(`/ordem/${event.target.value}`);
              }}>
                <option value="" disabled>Selecione o equipamento</option>
                {overviewGroup.orders.map((item, index) => (
                  <option key={item.id} value={item.id}>
                    {item.equipment?.labelCode ? `Etiqueta ${item.equipment.labelCode}` : `Equipamento ${index + 1}`}
                    {item.equipment?.environment ? ` — ${item.equipment.environment}` : ""}
                  </option>
                ))}
              </select>
              <p>Selecione o equipamento para acessar as ações do seu atendimento.</p>
            </article>
          )}

          {!overviewGroup && !order.equipment && (
            <p className="detail-card">Esta OS não tem equipamento cadastrado.</p>
          )}

          {!overviewGroup && order.equipment && (
            <details className="detail-card equipment-detail-fields">
              <summary>Dados do equipamento</summary>
              <dl className="equipment-selection-data">
                {[
                  ["Código da etiqueta", order.equipment.labelCode],
                  ["Ambiente", order.equipment.environment],
                  ["Marca", order.equipment.brand],
                  ["Modelo", order.equipment.model],
                  ["Número de série", order.equipment.serialNumber],
                  ["Local", order.equipment.location],
                  ["Endereço do equipamento", order.equipment.address],
                  ["Tipo do equipamento", order.equipment.equipmentType],
                  ["Capacidade BTUs", order.equipment.capacityBtus],
                  ["Tensão", order.equipment.voltage],
                  ["Gás refrigerante", order.equipment.refrigerantGas],
                  ["Local de instalação", order.equipment.installationLocation],
                  ["Pavimento", order.equipment.floor],
                  ["Observação", order.equipment.observation],
                ].map(([label, value]) => (
                  <div key={label}><dt>{label}</dt><dd>{value || "Não informado"}</dd></div>
                ))}
              </dl>
            </details>
          )}

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
                disabled={Boolean(overviewGroup)}
                onClick={() => setSuspendingOrder(true)}
              >
                <PauseCircle size={21} />
                Suspender
              </button>
            )}
            {order.statusId === 3 && (
              <button type="button" className="stage-button finish" disabled={closingLoading || Boolean(overviewGroup)} onClick={openClosingFlow}>
                <Flag size={21} />
                {closingLoading ? "Carregando atendimento..." : "Encerrar atendimento"}
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
                  origemOrdem: overviewGroup?.id ?? order.id,
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

          {closingOrder && closingContext && closingContext.order.id === order.id && (
            <ClosingModal
              key={`${closingContext.key}:${closingStep}`}
              answers={closingAnswers}
              currentStep={closingStep}
              onAnswer={(questionId, value, append) => void updateClosingAnswer(questionId, value, closingContext, append)}
              onBack={() => setClosingStep((current) => Math.max(0, current - 1))}
              onClose={closeClosingFlow}
              onFinish={() => void finishOrder(closingContext.order)}
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

  function renderEquipmentList(group: ServiceOrderGroup<ServiceOrder>) {
    const order = group.representative;

    return (
      <main className="app-shell app-shell-orders">
        <section className="order-detail-screen equipment-selection-screen" aria-label="Equipamentos da ordem de serviço">
          <header className="detail-header">
            <button
              type="button"
              className="back-button"
              onClick={() => navigateTo("/ordens")}
              aria-label="Voltar"
              title="Voltar"
            >
              <ArrowLeft size={22} />
            </button>
            <div>
              <span>{order.number}</span>
              <h1>Equipamentos da ordem</h1>
            </div>
            <button type="button" className="logout-button detail-logout" onClick={handleLogout} aria-label="Sair" title="Sair">
              <LogOut size={20} />
            </button>
          </header>

          <article className="equipment-order-summary">
            <div>
              <span>Cliente</span>
              <strong>{order.client}</strong>
            </div>
            <span className={`order-status status-${order.statusId}`}>
              <Clock3 size={17} />
              {order.status}
            </span>
          </article>

          <button type="button" className="stage-button" onClick={() => navigateTo(getOrderDetailsPath(group))}>
            <ClipboardList size={21} />
            Detalhes da OS
          </button>

          <div className="equipment-selection-list">
            {group.orders.map((equipmentOrder) => {
              const equipment = equipmentOrder.equipment;

              return (
                <button
                  type="button"
                  className="equipment-selection-card"
                  key={equipmentOrder.id}
                  onClick={() => navigateTo(`/ordem/${equipmentOrder.id}`)}
                >
                  <div className="equipment-selection-heading">
                    <span className="equipment-selection-icon"><Wrench size={23} /></span>
                    <div>
                      <small>Código da etiqueta</small>
                      <strong>{equipment?.labelCode || "Não informado"}</strong>
                    </div>
                    <ChevronRight size={24} />
                  </div>
                  <dl className="equipment-selection-data">
                    <div>
                      <dt>Ambiente</dt>
                      <dd>{equipment?.environment || "Não informado"}</dd>
                    </div>
                    <div>
                      <dt>Marca</dt>
                      <dd>{equipment?.brand || "Não informado"}</dd>
                    </div>
                    <div>
                      <dt>Modelo</dt>
                      <dd>{equipment?.model || "Não informado"}</dd>
                    </div>
                    <div>
                      <dt>Número de série</dt>
                      <dd>{equipment?.serialNumber || "Não informado"}</dd>
                    </div>
                  </dl>
                  <span className={`equipment-selection-status status-${equipmentOrder.statusId}`}>
                    {equipmentOrder.status}
                  </span>
                </button>
              );
            })}
          </div>
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
    if ((selectedOrder || selectedOrderGroup) && (detailsLoading || resolvedDetailRoute !== route.orderId)) {
      return (
        <main className="app-shell app-shell-orders">
          <section className="order-detail-screen">
            <header className="detail-header">
              <button type="button" className="back-button" onClick={() => navigateTo("/ordens")} aria-label="Voltar"><ArrowLeft size={22} /></button>
              <h1>Detalhes da ordem</h1>
            </header>
            <article className="detail-card" aria-live="polite">
              <p>{detailsError || "Carregando dados da ordem..."}</p>
              {detailsError && <button type="button" className="stage-button" disabled={detailsLoading} onClick={() => {
                const routeId = route.orderId!;
                setDetailsLoading(true);
                setDetailsError("");
                void loadServiceOrderDetails(routeId).then((result) => {
                  if (activeRoute.current.orderId === routeId && result) setResolvedDetailRoute(routeId);
                }).catch((error: unknown) => {
                  if (activeRoute.current.orderId === routeId) setDetailsError(error instanceof Error ? error.message : "Não foi possível carregar os detalhes.");
                }).finally(() => setDetailsLoading(false));
              }}>Tentar novamente</button>}
            </article>
          </section>
        </main>
      );
    }
    if (selectedOrder) {
      return renderOrderDetail(selectedOrder);
    }

    if (selectedOrderGroup?.isEquipmentBased) {
      if (route.overview) return renderOrderDetail(selectedOrderGroup.representative, selectedOrderGroup);
      return renderEquipmentList(selectedOrderGroup);
    }

    return renderOrders();
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
