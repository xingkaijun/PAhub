/// <reference types="vite/client" />

interface ImportMetaEnv {
    readonly VITE_DATA_API_BASE_URL?: string;
    readonly VITE_DATA_API_TOKEN?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
