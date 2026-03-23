import AzureBlobStorageAdapter, { AzureBlobStorageOptions } from './AzureBlobStorageAdapter';

class AzureImagesStorage extends AzureBlobStorageAdapter {
  constructor(config: AzureBlobStorageOptions = {}) {
    super({ container: 'images', contentPath: 'images', ...config });
  }
}

export default AzureImagesStorage;
