class SyncService {
  canSync(): boolean {
    return false;
  }

  async syncAll(): Promise<void> {}

  debouncedPush(_entityType: string, _entityId: number): void {}
}

export const syncService = new SyncService();
