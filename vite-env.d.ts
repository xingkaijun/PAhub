/// <reference types="vite/client" />

interface ImportMetaEnv {
    readonly VITE_PUSH_PASSWORD: string;
    readonly VITE_EDIT_PASSWORD?: string;
    readonly VITE_DATA_API_BASE_URL?: string;
    readonly VITE_DATA_API_TOKEN?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
