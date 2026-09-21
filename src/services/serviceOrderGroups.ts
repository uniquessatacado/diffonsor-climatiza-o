export type GroupableServiceOrder = {
  id: string;
  apiId?: string;
  apiOrderCode: string;
  equipmentOrderId?: string;
  equipment?: unknown;
  statusId: number;
  status: string;
  statusStartedAt?: string;
};

export type ServiceOrderGroup<T extends GroupableServiceOrder> = {
  id: string;
  isEquipmentBased: boolean;
  orders: T[];
  representative: T;
};

export function getEquipmentGroupId(order: GroupableServiceOrder) {
  const orderKey = `${order.apiId ?? ""}:${order.apiOrderCode}`;
  return `equipamentos-${encodeURIComponent(orderKey)}`;
}

export function aggregateEquipmentStatus(orders: GroupableServiceOrder[]) {
  const statusIds = orders.map((order) => order.statusId);

  if (statusIds.length > 0 && statusIds.every((statusId) => statusId === 5)) {
    return 5;
  }

  if (statusIds.length > 0 && statusIds.every((statusId) => statusId === 6)) {
    return 6;
  }

  if (
    statusIds.length > 0 &&
    statusIds.every((statusId) => statusId === 5 || statusId === 6) &&
    statusIds.some((statusId) => statusId === 5)
  ) {
    return 5;
  }

  if (statusIds.some((statusId) => [2, 3, 4].includes(statusId))) {
    return 3;
  }

  return 1;
}

function hasEquipmentData(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const equipment = value as Record<string, unknown>;
  const equipmentId = String(equipment.clientEquipmentId ?? "").trim();
  if (equipmentId && !["false", "null", "undefined", "nan", "infinity"].includes(equipmentId.toLowerCase())
    && (Number.isNaN(Number(equipmentId)) || Number(equipmentId) > 0)) return true;
  return ["labelCode", "brand", "model", "serialNumber", "code"].some((key) => {
    if (typeof equipment[key] !== "string" && typeof equipment[key] !== "number") return false;
    const text = String(equipment[key]).trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    return text && !["nao informado", "nao informada", "servico nao informado", "false", "null", "undefined"].includes(text);
  });
}

export function groupServiceOrders<T extends GroupableServiceOrder>(
  orders: T[],
  statusLabels: Record<number, string>,
): ServiceOrderGroup<T>[] {
  const groups = new Map<string, ServiceOrderGroup<T>>();

  orders.forEach((order) => {
    if (!hasEquipmentData(order.equipment)) {
      groups.set(`legado-${order.id}`, {
        id: order.id,
        isEquipmentBased: false,
        orders: [order],
        representative: order,
      });
      return;
    }

    const groupId = getEquipmentGroupId(order);
    const current = groups.get(groupId);

    if (current) {
      current.orders.push(order);
      return;
    }

    groups.set(groupId, {
      id: groupId,
      isEquipmentBased: true,
      orders: [order],
      representative: order,
    });
  });

  return Array.from(groups.values()).map((group) => {
    if (!group.isEquipmentBased) {
      return group;
    }

    const statusId = aggregateEquipmentStatus(group.orders);
    const timedOrder = group.orders.find((order) => [2, 3, 4].includes(order.statusId));

    return {
      ...group,
      representative: {
        ...group.representative,
        statusId,
        status: statusLabels[statusId],
        statusStartedAt: timedOrder?.statusStartedAt ?? group.representative.statusStartedAt,
      },
    };
  });
}
