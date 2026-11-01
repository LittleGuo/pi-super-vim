/**
 * pi loads project extensions from `.pi/extensions/`.
 *
 * The implementation lives in the repository root so that it can also be loaded
 * directly with `pi --extension ./pi-super-vim.ts`.
 */
export { default } from "../../pi-super-vim.ts";
