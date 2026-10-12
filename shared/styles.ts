/**
 * Picture styles: one suffix for every scene's image prompt, so the whole video looks drawn by one hand. The tile is a
 * small drawn sample (src/app/StoryStyles.tsx), never an AI picture.
 */
export const storyStyles = {
  doodle: {
    name: "Doodle", short: "Hand-drawn cartoon",
    prompt: "hand-drawn doodle cartoon illustration, bold black ink outlines of even thickness, flat pastel colours (mint, peach, lavender, butter yellow, sky blue), simple shapes, plain light background, friendly expressive faces, no shading or gradients, like a whiteboard explainer sketch",
  },
  watercolor: {
    name: "Watercolor", short: "Soft painted washes",
    prompt: "soft watercolour painting, loose wet-on-wet washes, visible paper texture, gentle bleeding edges, muted harmonious colours, light pencil lines, airy white space",
  },
  clay: {
    name: "3D clay", short: "Claymation figures",
    prompt: "3D claymation scene, soft rounded plasticine figures and objects with visible fingerprints, matte clay materials, warm studio lighting, shallow depth of field, miniature diorama set, bright cheerful colours",
  },
  comic: {
    name: "Comic", short: "Inked, halftone",
    prompt: "comic book illustration, bold ink lines, cel shading, halftone dot texture, saturated primary colours, dynamic framing, dramatic lighting, no speech bubbles or lettering",
  },
  flat: {
    name: "Flat vector", short: "Clean geometric",
    prompt: "flat vector illustration, clean geometric shapes without outlines, limited modern colour palette, subtle grain, simple background, plenty of negative space, explainer-video style",
  },
  cinematic: {
    name: "Cinematic photo", short: "Realistic, filmic",
    prompt: "cinematic photograph, realistic, shot on 35mm film, shallow depth of field, soft natural light, rich colour grading, detailed textures",
  },
  anime: {
    name: "Anime", short: "Cel-shaded drawing",
    prompt: "anime illustration, clean cel-shaded line art, expressive characters, vibrant colours, painterly sky and background detail, soft lighting, modern Japanese animated film look (no existing characters)",
  },
  storybook: {
    name: "Storybook", short: "Children's book",
    prompt: "children's picture book illustration, soft gouache and coloured pencil, warm gentle colours, rounded friendly characters, cosy detailed backgrounds, whimsical and calm",
  },
  toy3d: {
    name: "3D cartoon", short: "Glossy animated film",
    prompt: "3D animated feature film still, stylised cartoon characters with big expressive eyes, smooth glossy materials, soft global illumination, vibrant colours, cinematic depth of field (original characters only)",
  },
  dark: {
    name: "Dark fantasy", short: "Moody, eerie",
    prompt: "dark fantasy digital painting, moody low-key lighting, deep shadows, cold blue and ember orange palette, fog and mist, eerie atmosphere, highly detailed, cinematic composition, no gore",
  },
  vintage: {
    name: "Vintage film", short: "Old faded photo",
    prompt: "vintage film photograph, 1970s analogue look, faded warm colours, soft grain, light leaks, slightly soft focus, nostalgic documentary feel",
  },
  oil: {
    name: "Oil painting", short: "Classical brushwork",
    prompt: "classical oil painting on canvas, visible confident brushstrokes, rich warm palette, dramatic chiaroscuro lighting, museum masterpiece composition",
  },
  sketch: {
    name: "Pencil sketch", short: "Graphite on paper",
    prompt: "detailed graphite pencil sketch on off-white paper, expressive hatching and cross-hatching, soft smudged shading, monochrome, artist's sketchbook page",
  },
  pixel: {
    name: "Pixel art", short: "Retro game",
    prompt: "16-bit pixel art scene, crisp visible pixels, limited retro game palette, simple dithered shading, side-on view, nostalgic video game look (original characters only)",
  },
  neon: {
    name: "Neon", short: "Synthwave glow",
    prompt: "neon synthwave illustration, glowing magenta and cyan lights, dark night background, retro-futuristic city, reflections on wet surfaces, bold high-contrast colours",
  },
} as const;
export type StoryStyle = keyof typeof storyStyles;
export const storyStyleIds = Object.keys(storyStyles) as StoryStyle[];
