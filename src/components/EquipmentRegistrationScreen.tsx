import { useEffect, useMemo, useRef, useState } from "react";
import $ from "jquery";
import select2Factory from "select2/dist/js/select2.js";
import "select2/dist/css/select2.min.css";
import {
  ArrowLeft,
  Camera,
  CheckCircle2,
  ImagePlus,
  LoaderCircle,
  Save,
  Wrench,
  X,
} from "lucide-react";
import { getErrorMessage } from "../services/api";
import { isDeviceOnline } from "../services/connectivity";
import {
  createEquipment,
  fetchClients,
  fetchEquipmentTypes,
  type ClientOption,
  type EquipmentRegistrationPayload,
  type EquipmentTypeOption,
} from "../services/equipmentRegistration";

select2Factory(window, $);

const maxImageBytes = 12 * 1024 * 1024;
const maxImageSourceBytes = 30 * 1024 * 1024;
const maxImageDimension = 1600;

type EquipmentForm = Omit<EquipmentRegistrationPayload, "id_colaborador">;

type SelectedPhoto = {
  id: string;
  file: File;
  previewUrl: string;
};

type EquipmentRegistrationScreenProps = {
  collaboratorId: number | string;
  initialClientId?: string;
  initialClientName?: string;
  isTestMode: boolean;
  onBack: () => void;
};

type SearchableSelectOption = {
  value: string;
  label: string;
};

type SearchableSelectProps = {
  ariaLabel: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  options: SearchableSelectOption[];
  placeholder: string;
  value: string;
};

const initialForm: EquipmentForm = {
  codigo_etiqueta: "",
  id_tipo_equipamento: "",
  id_clientes: "",
  marca: "",
  modelo: "",
  local_instalacao: "",
  ambiente: "",
  area_climatizada: "",
  ocupantes_fixos: "",
  ocupantes_flutuantes: "",
  numero_serie: "",
  capacidade_btus: "",
  tensao: "",
  gas_refrigerante: "",
  modelo_condensadora: "",
  numero_serie_condensadora: "",
  local_instalacao_condensadora: "",
  observacao: "",
};

function SearchableSelect({
  ariaLabel,
  disabled = false,
  onChange,
  options,
  placeholder,
  value,
}: SearchableSelectProps) {
  const selectRef = useRef<HTMLSelectElement | null>(null);
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const element = selectRef.current;

    if (!element) {
      return;
    }

    const select = $(element);
    select.select2({
      width: "100%",
      placeholder,
      allowClear: true,
      language: {
        noResults: () => "Nenhum resultado encontrado",
        searching: () => "Buscando...",
      },
    });
    select.val(value).trigger("change.select2");
    select.on("change.equipment-select2", () => {
      onChangeRef.current(String(select.val() ?? ""));
    });

    return () => {
      select.off("change.equipment-select2");
      if (select.hasClass("select2-hidden-accessible")) {
        select.select2("destroy");
      }
    };
  }, [options, placeholder]);

  useEffect(() => {
    const element = selectRef.current;

    if (!element) {
      return;
    }

    const select = $(element);
    select.prop("disabled", disabled);
    if (select.hasClass("select2-hidden-accessible")) {
      select.trigger("change.select2");
    }
  }, [disabled]);

  useEffect(() => {
    const element = selectRef.current;

    if (!element) {
      return;
    }

    const select = $(element);
    if (String(select.val() ?? "") !== value) {
      select.val(value).trigger("change.select2");
    }
  }, [value]);

  return (
    <select
      ref={selectRef}
      defaultValue={value}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-required="true"
    >
      <option value="" />
      {options.map((option) => (
        <option value={option.value} key={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function createLocalId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function isImageFile(file: File) {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return file.type.startsWith("image/") || ["jpg", "jpeg", "png", "webp", "heic", "heif"].includes(extension);
}

async function optimizeImage(file: File) {
  if (!isImageFile(file) || /gif|svg|heic|heif/i.test(file.type + file.name)) {
    return file;
  }

  const sourceUrl = URL.createObjectURL(file);

  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const nextImage = new Image();
      nextImage.onload = () => resolve(nextImage);
      nextImage.onerror = () => reject(new Error("Não foi possível ler a imagem."));
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
      canvas.toBlob(resolve, "image/jpeg", 0.82);
    });

    if (!optimizedBlob || (scale === 1 && optimizedBlob.size >= file.size)) {
      return file;
    }

    const baseName = file.name.replace(/\.[^.]+$/, "") || "foto-equipamento";
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

export function EquipmentRegistrationScreen({
  collaboratorId,
  initialClientId = "",
  initialClientName = "",
  isTestMode,
  onBack,
}: EquipmentRegistrationScreenProps) {
  const normalizedCollaboratorId = String(collaboratorId ?? "").trim();
  const [form, setForm] = useState<EquipmentForm>(initialForm);
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [equipmentTypes, setEquipmentTypes] = useState<EquipmentTypeOption[]>([]);
  const [photos, setPhotos] = useState<SelectedPhoto[]>([]);
  const [loadingOptions, setLoadingOptions] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [preparingPhotos, setPreparingPhotos] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"error" | "success" | "info">("info");
  const galleryInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const photosRef = useRef<SelectedPhoto[]>([]);
  const initialClientAppliedRef = useRef(false);

  const canSubmit = useMemo(
    () => Boolean(form.id_clientes && form.id_tipo_equipamento && normalizedCollaboratorId),
    [form.id_clientes, form.id_tipo_equipamento, normalizedCollaboratorId],
  );
  const clientSelectOptions = useMemo(
    () => clients.map((client) => ({ value: String(client.id), label: client.razao_social })),
    [clients],
  );
  const equipmentTypeSelectOptions = useMemo(
    () => equipmentTypes.map((type) => ({ value: String(type.id), label: type.descricao })),
    [equipmentTypes],
  );

  useEffect(() => {
    photosRef.current = photos;
  }, [photos]);

  useEffect(() => {
    if (initialClientAppliedRef.current || clients.length === 0) {
      return;
    }

    initialClientAppliedRef.current = true;
    const clientById = initialClientId
      ? clients.find((client) => String(client.id) === String(initialClientId))
      : undefined;
    const normalizedInitialName = initialClientName.trim().toLocaleLowerCase("pt-BR");
    const clientByName = normalizedInitialName
      ? clients.find(
          (client) => client.razao_social.trim().toLocaleLowerCase("pt-BR") === normalizedInitialName,
        )
      : undefined;
    const selectedClient = clientById ?? clientByName;

    if (selectedClient) {
      setForm((current) => ({ ...current, id_clientes: String(selectedClient.id) }));
    }
  }, [clients, initialClientId, initialClientName]);

  useEffect(() => {
    if (normalizedCollaboratorId) {
      setMessage((current) =>
        /c[oó]digo do colaborador/i.test(current) ? "" : current,
      );
      return;
    }

    setMessageType("error");
    setMessage("Código do colaborador não localizado na sessão. Saia e entre novamente no aplicativo.");
  }, [normalizedCollaboratorId]);

  useEffect(
    () => () => {
      photosRef.current.forEach((photo) => URL.revokeObjectURL(photo.previewUrl));
    },
    [],
  );

  useEffect(() => {
    let active = true;

    async function loadOptions() {
      setLoadingOptions(true);
      setMessage("");

      if (isTestMode) {
        setClients([{ id: "teste", razao_social: "CLIENTE DE TESTE" }]);
        setEquipmentTypes([{ id: "teste", descricao: "EQUIPAMENTO DE TESTE" }]);
        setLoadingOptions(false);
        return;
      }

      if (!(await isDeviceOnline())) {
        if (active) {
          setMessageType("error");
          setMessage("Você está offline. Reconecte para carregar clientes e tipos de equipamento.");
          setLoadingOptions(false);
        }
        return;
      }

      try {
        const [nextClients, nextEquipmentTypes] = await Promise.all([
          fetchClients(),
          fetchEquipmentTypes(),
        ]);

        if (active) {
          setClients(nextClients);
          setEquipmentTypes(nextEquipmentTypes);
        }
      } catch (error) {
        if (active) {
          setMessageType("error");
          setMessage(getErrorMessage(error));
        }
      } finally {
        if (active) {
          setLoadingOptions(false);
        }
      }
    }

    void loadOptions();
    return () => {
      active = false;
    };
  }, [isTestMode]);

  function setField<K extends keyof EquipmentForm>(field: K, value: EquipmentForm[K]) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function appendPhotos(files: FileList | null) {
    const selectedFiles = Array.from(files ?? []);

    if (selectedFiles.length === 0) {
      return;
    }

    setPreparingPhotos(true);
    setMessage("");

    try {
      const validImages = selectedFiles.filter(
        (file) => isImageFile(file) && file.size <= maxImageSourceBytes,
      );
      const preparedImages = await Promise.all(validImages.map(optimizeImage));
      const acceptedImages = preparedImages.filter((file) => file.size <= maxImageBytes);
      const rejectedCount = selectedFiles.length - acceptedImages.length;
      const nextPhotos = acceptedImages.map((file) => ({
        id: createLocalId(),
        file,
        previewUrl: URL.createObjectURL(file),
      }));

      setPhotos((current) => [...current, ...nextPhotos]);

      if (rejectedCount > 0) {
        setMessageType("error");
        setMessage(
          `${rejectedCount} arquivo(s) não foram incluídos. Selecione somente imagens de até 12 MB; fotos comuns são reduzidas automaticamente.`,
        );
      }
    } finally {
      setPreparingPhotos(false);
    }
  }

  function handleInputFiles(input: HTMLInputElement) {
    void appendPhotos(input.files);
    input.value = "";
  }

  function removePhoto(photoId: string) {
    setPhotos((current) => {
      const photo = current.find((item) => item.id === photoId);
      if (photo) {
        URL.revokeObjectURL(photo.previewUrl);
      }
      return current.filter((item) => item.id !== photoId);
    });
  }

  function resetAfterSuccess() {
    photosRef.current.forEach((photo) => URL.revokeObjectURL(photo.previewUrl));
    setPhotos([]);
    setForm(initialForm);
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!normalizedCollaboratorId) {
      setMessageType("error");
      setMessage("A sessão não informou o código do colaborador. Volte, saia do aplicativo e entre novamente.");
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }

    if (!canSubmit) {
      setMessageType("error");
      setMessage("Selecione o cliente e o tipo de equipamento.");
      return;
    }

    if (isTestMode) {
      setMessageType("success");
      setMessage("Cadastro de teste concluído localmente. Nenhum dado foi enviado para a API real.");
      resetAfterSuccess();
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }

    if (!(await isDeviceOnline())) {
      setMessageType("error");
      setMessage("Você está offline. Reconecte para cadastrar o equipamento.");
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }

    setSubmitting(true);
    setMessage("");

    try {
      const response = await createEquipment(
        {
          ...form,
          id_colaborador: normalizedCollaboratorId,
        },
        photos.map((photo) => photo.file),
      );

      resetAfterSuccess();
      setMessageType("success");
      setMessage(response.mensagem ?? "Equipamento cadastrado com sucesso.");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      setMessageType("error");
      setMessage(getErrorMessage(error));
      window.scrollTo({ top: 0, behavior: "smooth" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="app-shell app-shell-orders">
      <section className="equipment-screen" aria-label="Cadastro de equipamento">
        <header className="detail-header equipment-header">
          <button type="button" className="back-button" onClick={onBack} aria-label="Voltar" title="Voltar">
            <ArrowLeft size={22} />
          </button>
          <div>
            <span>Área técnica</span>
            <h1>Adicionar equipamento</h1>
          </div>
          <span className="equipment-header-icon" aria-hidden="true">
            <Wrench size={23} />
          </span>
        </header>

        {message && (
          <p className={`equipment-message ${messageType}`} role="status">
            {messageType === "success" ? <CheckCircle2 size={22} /> : messageType === "error" ? <X size={22} /> : null}
            <span>{message}</span>
          </p>
        )}

        <form className="equipment-form" onSubmit={handleSubmit}>
          <section className="equipment-form-section">
            <div className="equipment-section-heading">
              <span>1</span>
              <div>
                <h2>Informações do equipamento</h2>
                <p>Os campos com * são obrigatórios.</p>
              </div>
            </div>

            <div className="equipment-fields-grid">
              <label className="equipment-field">
                <span>Código da etiqueta</span>
                <input
                  value={form.codigo_etiqueta}
                  onChange={(event) => setField("codigo_etiqueta", event.target.value)}
                />
              </label>

              <label className="equipment-field">
                <span>Tipo de equipamento *</span>
                <SearchableSelect
                  ariaLabel="Localizar tipo de equipamento"
                  value={form.id_tipo_equipamento}
                  onChange={(value) => setField("id_tipo_equipamento", value)}
                  disabled={loadingOptions}
                  placeholder={loadingOptions ? "Carregando tipos..." : "Digite para localizar o tipo"}
                  options={equipmentTypeSelectOptions}
                />
              </label>

              <label className="equipment-field equipment-field-wide">
                <span>Cliente *</span>
                <SearchableSelect
                  ariaLabel="Localizar cliente"
                  value={form.id_clientes}
                  onChange={(value) => setField("id_clientes", value)}
                  disabled={loadingOptions}
                  placeholder={loadingOptions ? "Carregando clientes..." : "Digite para localizar o cliente"}
                  options={clientSelectOptions}
                />
              </label>

              <label className="equipment-field">
                <span>Marca</span>
                <input value={form.marca} onChange={(event) => setField("marca", event.target.value)} />
              </label>

              <label className="equipment-field">
                <span>Modelo</span>
                <input value={form.modelo} onChange={(event) => setField("modelo", event.target.value)} />
              </label>

              <label className="equipment-field">
                <span>Local de instalação</span>
                <input
                  value={form.local_instalacao}
                  onChange={(event) => setField("local_instalacao", event.target.value)}
                />
              </label>

              <label className="equipment-field">
                <span>Ambiente</span>
                <input value={form.ambiente} onChange={(event) => setField("ambiente", event.target.value)} />
              </label>

              <label className="equipment-field">
                <span>Área climatizada (m²)</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  value={form.area_climatizada}
                  onChange={(event) => setField("area_climatizada", event.target.value)}
                />
              </label>

              <label className="equipment-field">
                <span>Ocupantes fixos</span>
                <input
                  type="number"
                  min="0"
                  inputMode="numeric"
                  value={form.ocupantes_fixos}
                  onChange={(event) => setField("ocupantes_fixos", event.target.value)}
                />
              </label>

              <label className="equipment-field">
                <span>Ocupantes flutuantes</span>
                <input
                  type="number"
                  min="0"
                  inputMode="numeric"
                  value={form.ocupantes_flutuantes}
                  onChange={(event) => setField("ocupantes_flutuantes", event.target.value)}
                />
              </label>

              <label className="equipment-field">
                <span>Número de série</span>
                <input value={form.numero_serie} onChange={(event) => setField("numero_serie", event.target.value)} />
              </label>

              <label className="equipment-field">
                <span>Capacidade em BTU</span>
                <input
                  value={form.capacidade_btus}
                  onChange={(event) => setField("capacidade_btus", event.target.value)}
                  placeholder="Ex.: 12000 BTUs"
                />
              </label>

              <label className="equipment-field">
                <span>Tensão</span>
                <input
                  value={form.tensao}
                  onChange={(event) => setField("tensao", event.target.value)}
                  inputMode="numeric"
                  placeholder="Ex.: 220"
                />
              </label>

              <label className="equipment-field">
                <span>Fluido refrigerante</span>
                <input
                  value={form.gas_refrigerante}
                  onChange={(event) => setField("gas_refrigerante", event.target.value)}
                />
              </label>

              <label className="equipment-field">
                <span>Modelo da condensadora</span>
                <input
                  value={form.modelo_condensadora}
                  onChange={(event) => setField("modelo_condensadora", event.target.value)}
                />
              </label>

              <label className="equipment-field">
                <span>Número de série da condensadora</span>
                <input
                  value={form.numero_serie_condensadora}
                  onChange={(event) => setField("numero_serie_condensadora", event.target.value)}
                />
              </label>

              <label className="equipment-field equipment-field-wide">
                <span>Local de instalação da condensadora</span>
                <input
                  value={form.local_instalacao_condensadora}
                  onChange={(event) => setField("local_instalacao_condensadora", event.target.value)}
                />
              </label>
            </div>
          </section>

          <section className="equipment-form-section">
            <div className="equipment-section-heading">
              <span>2</span>
              <div>
                <h2>Observação e galeria de fotos</h2>
                <p>Adicione quantas imagens forem necessárias.</p>
              </div>
            </div>

            <label className="equipment-field">
              <span>Observação</span>
              <textarea
                value={form.observacao}
                onChange={(event) => setField("observacao", event.target.value)}
                rows={5}
              />
            </label>

            <div className="equipment-photo-actions">
              <button
                type="button"
                className="media-action"
                onClick={() => galleryInputRef.current?.click()}
                disabled={preparingPhotos || submitting}
              >
                <ImagePlus size={22} />
                <span>Escolher fotos</span>
              </button>
              <button
                type="button"
                className="media-action"
                onClick={() => cameraInputRef.current?.click()}
                disabled={preparingPhotos || submitting}
              >
                <Camera size={22} />
                <span>Tirar foto</span>
              </button>
              <input
                ref={galleryInputRef}
                className="native-file-input"
                type="file"
                accept="image/*"
                multiple
                onChange={(event) => handleInputFiles(event.currentTarget)}
              />
              <input
                ref={cameraInputRef}
                className="native-file-input"
                type="file"
                accept="image/*"
                capture="environment"
                onChange={(event) => handleInputFiles(event.currentTarget)}
              />
            </div>

            {preparingPhotos && (
              <p className="equipment-photo-status">
                <LoaderCircle size={20} className="spin" />
                Preparando fotos...
              </p>
            )}

            {photos.length > 0 && (
              <>
                <p className="selected-media">{photos.length} foto(s) adicionada(s)</p>
                <div className="media-preview-grid equipment-photo-grid">
                  {photos.map((photo) => (
                    <div className="media-preview" key={photo.id}>
                      <img src={photo.previewUrl} alt={photo.file.name || "Foto do equipamento"} />
                      <div className="media-name">
                        <strong>{photo.file.name || "Foto do equipamento"}</strong>
                        <span>{formatBytes(photo.file.size)}</span>
                      </div>
                      <button type="button" onClick={() => removePhoto(photo.id)} disabled={submitting}>
                        Remover
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>

          <div className="equipment-form-actions">
            <button type="button" className="stage-button secondary" onClick={onBack} disabled={submitting}>
              Cancelar
            </button>
            <button
              type="submit"
              className="stage-button equipment-save-button"
              disabled={!canSubmit || submitting || preparingPhotos || loadingOptions}
            >
              {submitting ? <LoaderCircle size={21} className="spin" /> : <Save size={21} />}
              {submitting ? "Enviando..." : "Cadastrar equipamento"}
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}
