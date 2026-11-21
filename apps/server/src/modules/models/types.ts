export type ModelValue = {
  name: string;
  providerId: string;
  modelId: string;
  credentialRef: string;
};
export type CreateModelInput = ModelValue & { id?: string };
export type UpdateModelInput = Partial<ModelValue>;
export type ModelListOptions = { limit?: number; offset?: number };
export type ModelConfig = ModelValue & {
  id: string;
  createdAt: number;
  updatedAt: number;
};
export type ModelPage = { items: ModelConfig[]; hasMore: boolean };
