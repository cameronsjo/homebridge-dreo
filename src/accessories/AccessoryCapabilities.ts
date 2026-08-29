interface CharacteristicService<TCharacteristicType, TCharacteristic> {
  getCharacteristic(type: TCharacteristicType): TCharacteristic;
  removeCharacteristic(characteristic: TCharacteristic): unknown;
}

interface AccessoryWithServices<TServiceType, TService> {
  getService(type: TServiceType): TService | undefined;
  removeService(service: TService): unknown;
}

export function removeUnsupportedCharacteristic<
  TCharacteristicType,
  TCharacteristic,
>(
  service: CharacteristicService<TCharacteristicType, TCharacteristic>,
  characteristicType: TCharacteristicType,
  supported: boolean,
): void {
  if (supported) {
    return;
  }

  const characteristic = service.getCharacteristic(characteristicType);
  service.removeCharacteristic(characteristic);
}

export function removeUnsupportedService<TServiceType, TService>(
  accessory: AccessoryWithServices<TServiceType, TService>,
  serviceType: TServiceType,
  supported: boolean,
): void {
  if (supported) {
    return;
  }

  const service = accessory.getService(serviceType);
  if (service !== undefined) {
    accessory.removeService(service);
  }
}
