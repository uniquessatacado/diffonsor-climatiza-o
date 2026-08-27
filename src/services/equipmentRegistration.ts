import { endpoints } from "../config/endpoints";
import { postJson, postMultipart } from "./api";

export type ClientOption = {
  id: number | string;
  razao_social: string;
};

export type EquipmentTypeOption = {
  id: number | string;
  descricao: string;
};

export type EquipmentRegistrationPayload = {
  id_colaborador: number | string;
  codigo_etiqueta: string;
  id_tipo_equipamento: string;
  id_clientes: string;
  marca: string;
  modelo: string;
  local_instalacao: string;
  ambiente: string;
  area_climatizada: string;
  ocupantes_fixos: string;
  ocupantes_flutuantes: string;
  numero_serie: string;
  capacidade_btus: string;
  tensao: string;
  gas_refrigerante: string;
  modelo_condensadora: string;
  numero_serie_condensadora: string;
  local_instalacao_condensadora: string;
  observacao: string;
};

export async function fetchClients() {
  const response = await postJson<ClientOption[]>(endpoints.clientsUrl, {});
  return Array.isArray(response.dados) ? response.dados : [];
}

export async function fetchEquipmentTypes() {
  const response = await postJson<EquipmentTypeOption[]>(endpoints.equipmentTypesUrl, {});
  return Array.isArray(response.dados) ? response.dados : [];
}

export async function createEquipment(payload: EquipmentRegistrationPayload, photos: File[]) {
  const formData = new FormData();

  Object.entries(payload).forEach(([key, value]) => {
    formData.append(key, String(value));
  });

  photos.forEach((photo) => {
    formData.append("fileMeta[]", photo, photo.name || "foto-equipamento.jpg");
  });

  return postMultipart<unknown>(endpoints.createEquipmentUrl, formData);
}
