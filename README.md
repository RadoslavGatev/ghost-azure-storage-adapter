# ghost-azure-storage-adapter

A Ghost storage adapter for Azure Blob Storage. Supports managed identity, account key, and connection string authentication using the latest `@azure/storage-blob` SDK.

## Installation

### Via npm (recommended)

```bash
npm install ghost-azure-storage-adapter
```

Ghost resolves adapters from `node_modules` first, so this works out of the box.

### Via content/adapters

Copy the built package into your Ghost installation:

```
content/adapters/storage/ghost-azure-storage-adapter/
  dist/
  node_modules/   (install production deps here)
  package.json
```

## Configuration

Add to your Ghost `config.production.json`:

```json
{
  "storage": {
    "active": "ghost-azure-storage-adapter",
    "ghost-azure-storage-adapter": {
      "connectionString": "DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;EndpointSuffix=core.windows.net",
      "container": "ghost-content"
    }
  }
}
```

### Authentication Options

The adapter supports three authentication methods (checked in priority order):

#### 1. Connection String

```json
{
  "connectionString": "DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;EndpointSuffix=core.windows.net",
  "container": "ghost-content"
}
```

#### 2. Account Name + Key

```json
{
  "accountName": "mystorageaccount",
  "accountKey": "base64key...",
  "container": "ghost-content"
}
```

#### 3. Managed Identity (DefaultAzureCredential)

```json
{
  "accountName": "mystorageaccount",
  "container": "ghost-content"
}
```

This uses `DefaultAzureCredential` from `@azure/identity`, which supports managed identity, Azure CLI, environment variables, and more.

### Full Options

| Option | Type | Default | Description |
|---|---|---|---|
| `connectionString` | string | — | Azure Storage connection string |
| `accountName` | string | — | Storage account name |
| `accountKey` | string | — | Storage account access key |
| `container` | string | `"ghost-content"` | Blob container name |
| `customDomain` | string | — | Custom domain URL (e.g., `https://cdn.example.com`) |
| `cacheControl` | string | `"public, max-age=2592000"` | Cache-Control header for uploaded blobs |
| `pathPrefix` | string | — | Path prefix inside container (e.g., `"images"`) |

## License

MIT
