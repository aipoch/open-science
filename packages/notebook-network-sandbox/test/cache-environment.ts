import { join } from 'node:path'

// Explicit protocol inputs; application cache layout is verified by the host.
export const cacheEnvironmentFixture = (cacheRoot: string): Record<string, string> => ({
  OPEN_SCIENCE_NOTEBOOK_CACHE_DIR: cacheRoot,
  MPLCONFIGDIR: join(cacheRoot, 'mplconfigdir'),
  PIP_CACHE_DIR: join(cacheRoot, 'pip_cache_dir'),
  UV_CACHE_DIR: join(cacheRoot, 'uv_cache_dir'),
  HF_HUB_CACHE: join(cacheRoot, 'hf_hub_cache'),
  HF_DATASETS_CACHE: join(cacheRoot, 'hf_datasets_cache'),
  HF_XET_CACHE: join(cacheRoot, 'hf_xet_cache'),
  HF_ASSETS_CACHE: join(cacheRoot, 'hf_assets_cache'),
  TORCH_HOME: join(cacheRoot, 'torch_home'),
  TORCHINDUCTOR_CACHE_DIR: join(cacheRoot, 'torchinductor_cache_dir'),
  TORCH_EXTENSIONS_DIR: join(cacheRoot, 'torch_extensions_dir'),
  PYTORCH_KERNEL_CACHE_PATH: join(cacheRoot, 'pytorch_kernel_cache_path'),
  TRITON_CACHE_DIR: join(cacheRoot, 'triton_cache_dir'),
  NUMBA_CACHE_DIR: join(cacheRoot, 'numba_cache_dir'),
  R_USER_CACHE_DIR: join(cacheRoot, 'r_user_cache_dir')
})
