interface AccessoryWithContext {
  readonly context: Record<string, unknown>;
}

export function refreshAccessoryMetadata<TDevice>(
  accessory: AccessoryWithContext,
  device: TDevice,
): void {
  accessory.context.device = device;
}
