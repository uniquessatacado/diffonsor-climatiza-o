import type { GroupableServiceOrder, ServiceOrderGroup } from "./serviceOrderGroups";

export function routeFromPath(pathname: string) {
  const orderMatch = pathname.match(/^\/ordem\/([^/]+)(\/detalhes)?$/);
  return {
    page: orderMatch ? "order"
      : pathname === "/equipamentos/novo" ? "equipment-registration"
        : pathname === "/ordens" ? "orders" : "login",
    orderId: orderMatch?.[1] ?? null,
    overview: Boolean(orderMatch?.[2]),
  };
}

export function getOrderEntryPath<T extends GroupableServiceOrder>(group: ServiceOrderGroup<T>) {
  return `/ordem/${group.isEquipmentBased ? group.id : group.representative.id}`;
}

export function getOrderDetailsPath<T extends GroupableServiceOrder>(group: ServiceOrderGroup<T>) {
  // A multi-equipment OS opens its technical overview; no item is chosen implicitly.
  return group.orders.length === 1
    ? `/ordem/${group.orders[0].id}`
    : `/ordem/${group.id}/detalhes`;
}
