export type MobileCatalogEntry = {
  localizationKey: string;
  locale: string;
  value: string;
  valueHash: string;
  domain: "scene" | "system_flow";
  documentId: string;
  documentTitle: string;
  context: {
    sceneId?: string;
    flowId?: string;
    nodeId?: string;
    variantId?: string;
    optionId?: string;
    speakerId?: string;
    layer?: "perceived" | "reality";
  };
  maxLength?: number | null;
  placeholders: string[];
  multiline: boolean;
  linkedLocalizationKeys?: string[];
};

export type MobileCatalogSnapshot = {
  schemaVersion: 1;
  projectId: string;
  projectTitle: string;
  defaultLocale: string;
  generation: string;
  updatedAt?: string | null;
  entries: MobileCatalogEntry[];
};

export type MobileChangeStatus = "editing" | "queued" | "pending" | "applied" | "conflict" | "rejected";

export type MobileTextChange = {
  eventId: string;
  projectId: string;
  localizationKey: string;
  locale: string;
  baseValue: string;
  baseValueHash: string;
  nextValue: string;
  deviceId: string;
  clientCreatedAt: string;
};

export type StoredMobileDraft = {
  id: string;
  projectId: string;
  localizationKey: string;
  locale: string;
  baseValue: string;
  baseValueHash: string;
  nextValue: string;
  eventId?: string;
  status: MobileChangeStatus;
  reason?: string;
  currentValue?: string;
  currentValueHash?: string;
  updatedAt: string;
};

export type StoredOutboxEvent = MobileTextChange & {
  uploaded: boolean;
};

export type ServerChange = MobileTextChange & {
  status: "pending" | "superseded" | "applied" | "conflict" | "rejected";
  serverCreatedAt: string;
  updatedAt: string;
  reason?: string;
  currentValue?: string;
  currentValueHash?: string;
};

export type MobileSyncReceipt = {
  eventId: string;
  status: "applied" | "conflict" | "rejected";
  reason?: string;
  currentValue?: string;
  currentValueHash?: string;
};

export type MobileApplyResult = {
  receipts: MobileSyncReceipt[];
  snapshot: MobileCatalogSnapshot;
};
