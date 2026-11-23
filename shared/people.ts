import { z } from "zod";

// Photos of the people a video is for (a holiday greeting, shared/templates.ts `greeting`): the owner uploads one to
// four photos of the people they greet, and the pictures of the video show those people in its scenes. The photos
// are references, never shown themselves: each scene's picture is drawn with them, in the video's art style
// (server/providers/fal.ts, the reference role "person"), and no reference sheet is drawn.
//
// They show real people, so the owner confirms each time that they have those people's permission (`consent`, kept
// with the video), and the terms say so. A test, for administrators, until PEOPLE_PHOTOS_OPEN.

/** Whether everyone can add photos of people (else administrators only: server/story.ts, server/videos.ts, Create). */
export const PEOPLE_PHOTOS_OPEN = false;
/** How many photos a video takes. */
export const PEOPLE_PHOTOS_MAX = 4;
/** The templates that take photos of people. */
export const takesPeople = (template: string) => template === "greeting";

export const peopleSchema = z.object({
  /** The owner's photos of the people (their uploads). */
  assets: z.array(z.uuid()).min(1).max(PEOPLE_PHOTOS_MAX).refine((ids) => new Set(ids).size === ids.length, "Add each photo once."),
  /** The owner confirmed that they have these people's permission to use the photos. */
  consent: z.literal(true, { error: "Confirm that you have these people's permission to use their photos." }),
});
export type People = z.infer<typeof peopleSchema>;

/** Added to a picture's description: who the people in it are, and how they are drawn. */
export const PEOPLE_STILL =
  " Where this picture shows the people from the photos, they are the ones in the reference photos: recognisably the same faces, hair and build, drawn in this video's art style, warm and natural, dressed for the scene.";
/** What the writer is told when the owner gave photos (server/story.ts). */
export const PEOPLE_RULE =
  "The owner gave photos of the people this video is for and confirmed that they have those people's permission, so showing them is allowed. They appear in most of the pictures, called \"the people from the photos\", in warm moments of the holidays (decorating the tree, at the table, opening a gift, out in the snow), usually together. The artist has their photos: never describe their looks, their ages or how many they are, and never give them names. The other pictures show the place and the things around them, with nobody in them.";
