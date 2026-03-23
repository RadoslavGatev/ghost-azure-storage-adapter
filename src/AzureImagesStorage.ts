import AzureBlobStorageAdapter, { AzureBlobStorageOptions } from './AzureBlobStorageAdapter';

class AzureImagesStorage extends AzureBlobStorageAdapter {
  constructor(config: AzureBlobStorageOptions = {}) {
    super({ container: 'images', contentPath: 'images', ...config });
  }
}

module.exports = AzureImagesStorage;
export default AzureImagesStorage;
