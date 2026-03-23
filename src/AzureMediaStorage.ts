import AzureBlobStorageAdapter, { AzureBlobStorageOptions } from './AzureBlobStorageAdapter';

class AzureMediaStorage extends AzureBlobStorageAdapter {
  constructor(config: AzureBlobStorageOptions = {}) {
    super({ container: 'media', contentPath: 'media', ...config });
  }
}

module.exports = AzureMediaStorage;
export default AzureMediaStorage;
