import AzureBlobStorageAdapter, { AzureBlobStorageOptions } from './AzureBlobStorageAdapter';

class AzureFilesStorage extends AzureBlobStorageAdapter {
  constructor(config: AzureBlobStorageOptions = {}) {
    super({ container: 'files', contentPath: 'files', ...config });
  }
}

module.exports = AzureFilesStorage;
export default AzureFilesStorage;
