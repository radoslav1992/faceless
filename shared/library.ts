import { soundCategories } from "./sounds";

// The shared library (server/library.ts): what kind of thing each item is. Music has a genre, clips, pictures and
// sound effects a category; administrators choose one of these (Admin → Library, where AI can suggest it) or write
// their own.

export type LibraryKind = "music" | "clip" | "image" | "sfx";
export const CATEGORY_MAX = 40;
export const musicGenres = [
  "Ambient", "Lo-fi", "Cinematic", "Orchestral", "Piano", "Acoustic", "Electronic", "Synthwave", "Hip hop", "Trap", "Pop", "Rock", "Jazz",
  "Classical", "Corporate", "World", "Horror",
] as const;
export const sceneCategories = [
  "Nature", "Ocean", "Space", "City", "Animals", "People", "Food", "Technology", "Science", "History", "Abstract", "Satisfying", "Gameplay",
  "Sports", "Travel", "Weather", "Dark and spooky",
] as const;
/** The suggested genres (music) or categories (clips and pictures, sound effects: shared/sounds.ts). */
export const categoriesFor = (kind: LibraryKind): readonly string[] => (kind === "music" ? musicGenres : kind === "sfx" ? soundCategories : sceneCategories);
/** "Genre" for music, "Category" for clips, pictures and sound effects. */
export const categoryLabel = (kind: LibraryKind) => (kind === "music" ? "Genre" : "Category");
