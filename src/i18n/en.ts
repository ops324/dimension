/**
 * English copy (Phase 45).
 *
 * The work is Japanese-first: `i18n/ja.ts` is the canon, and this file is a
 * translation that answers to it. Where the two diverge on purpose, the
 * reason is written down beside the divergence — a translation that quietly
 * drops a device is worse than one that is visibly literal.
 *
 * Two devices must survive the crossing, because the work is built on them:
 *
 *   ① **Names are language; numbers are arithmetic.** Proper names run out —
 *      cube, tesseract, penteract, hexeract, and then nothing — while the
 *      vertex and edge counts go on being exact for ever. The epilogue says
 *      “it is only that we have run out of names”, and `polytope.byNumber`
 *      below is where a reader watches that happen. Do not add a word for 7.
 *   ② **The Latin display type is shared.** DIMENSION / POINT / LINE and the
 *      instrument readings (`CH.04`, `AXIS 04 / EXTENT ∈ [0,1]^4`, `4D`) are
 *      the same in both languages — they are typography, not prose.
 *
 * The house style for the prose: poetic but never mathematically false;
 * two to four sentences; short breaths, because the body copy is set at
 * line-height 2; and one metaphor — extrusion — carried from 0D to 6D.
 */

import type { Chapter, Copy, ExhibitInfo } from './types';

/**
 * The vertical decoration (`writing-mode: vertical-rl`) beside each chapter.
 *
 * Japanese sets 序章 / 第〇章 / 終章 here. English cannot reuse the `index`
 * words (`PROLOGUE` / `EPILOGUE`) without printing them twice in one corner,
 * so the caption carries the bare ordinal and the index keeps the numeral.
 */
const CHAPTERS: readonly Chapter[] = [
  {
    id: 'prologue',
    en: 'DIMENSION',
    dim: 0,
    index: 'PROLOGUE',
    caption: 'OPENING',
    coord: 'AXIS -- / EXTENT ∅',
    role: 'prologue',
    hint: 'SCROLL',
    text: {
      title: 'Toward the dimensions you cannot see',
      body:
        'The human eye takes in three directions only. Height, width, and depth. ' +
        'Mathematics goes further all the same — unseen, and exact. ' +
        'With every scroll, the world gains one more direction.',
    },
  },
  {
    id: 'd0',
    en: 'POINT',
    dim: 0,
    index: 'CH.00',
    unit: '0D',
    caption: 'ZEROTH',
    coord: 'AXIS 00 / EXTENT ∅',
    role: 'chapter',
    text: {
      title: 'A place with no size',
      body:
        'A point has no extent. All it holds is the bare fact of “here.” ' +
        'No length, no area, no volume has been born yet. ' +
        'Every dimension begins in this silence.',
    },
  },
  {
    id: 'd1',
    en: 'LINE',
    dim: 1,
    index: 'CH.01',
    unit: '1D',
    caption: 'FIRST',
    coord: 'AXIS 01 / EXTENT ∈ [0,1]',
    role: 'chapter',
    text: {
      title: 'The point moves',
      body:
        'Move the point along a single direction. Its trace becomes a line, and length enters the world for the first time. ' +
        'To anything that lives inside the line, the world is forward and backward and nothing else. ' +
        'You may turn around; you may never pass another.',
    },
  },
  {
    id: 'd2',
    en: 'PLANE',
    dim: 2,
    index: 'CH.02',
    unit: '2D',
    caption: 'SECOND',
    coord: 'AXIS 02 / EXTENT ∈ [0,1]^2',
    role: 'chapter',
    text: {
      title: 'The line sweeps across',
      body:
        'Extrude the line in a direction at right angles to itself. The swept trace becomes a plane, and area is born. ' +
        'Here paths cross, circles close, and for the first time you can go around. ' +
        'Even so, there is still no such direction as up.',
    },
  },
  {
    id: 'd3',
    en: 'SOLID',
    dim: 3,
    index: 'CH.03',
    unit: '3D',
    caption: 'THIRD',
    coord: 'AXIS 03 / EXTENT ∈ [0,1]^3',
    role: 'chapter',
    text: {
      title: 'The room we live in',
      body:
        'Lift the plane the way you would lift paper off a table. Six faces close, and a cube is finished. ' +
        'This is the world we live in, and also the far edge of everything the eye can hold. ' +
        'Past here we give up seeing, and begin counting.',
    },
  },
  {
    id: 'd4',
    en: 'TESSERACT',
    dim: 4,
    index: 'CH.04',
    unit: '4D',
    caption: 'FOURTH',
    coord: 'AXIS 04 / EXTENT ∈ [0,1]^4',
    role: 'chapter',
    text: {
      title: 'The fourth direction',
      body:
        'Extrude the cube along a fourth direction, at right angles to every edge it has. That is the tesseract. ' +
        'Eight cubes close together, each still sharing its faces with the others. ' +
        'What you are looking at is no more than its shadow — ' +
        'the small cube on the inside is not shrinking; it is simply moving away along the fourth direction.',
    },
  },
  {
    id: 'd5',
    en: 'PENTERACT',
    dim: 5,
    index: 'CH.05',
    unit: '5D',
    caption: 'FIFTH',
    coord: 'AXIS 05 / EXTENT ∈ [0,1]^5',
    role: 'chapter',
    text: {
      title: 'Only the rule goes on',
      body:
        'One more direction at right angles. That alone makes the penteract — the five-dimensional hypercube. ' +
        'Thirty-two vertices, eighty edges, ten tesseracts. ' +
        'No image forms in the mind any longer, and still the numbers go on being exact.',
    },
  },
  {
    id: 'd6',
    en: 'HEXERACT',
    dim: 6,
    index: 'CH.06',
    unit: '6D',
    caption: 'SIXTH',
    coord: 'AXIS 06 / EXTENT ∈ [0,1]^6',
    role: 'chapter',
    text: {
      title: 'Two rotations at once',
      body:
        'The hexeract, the six-dimensional hypercube. Sixty-four vertices and a hundred and ninety-two edges are turning, all at the same time. ' +
        'In three dimensions, rotation always happens about a single axis. ' +
        'Past the fourth, a body can turn in two mutually independent planes at once — ' +
        'which is why the shadow unravels, turns inside out, and still never once breaks.',
    },
  },
  {
    id: 'epilogue',
    en: 'BEYOND',
    dim: 6,
    index: 'EPILOGUE',
    caption: 'CLOSING',
    coord: 'AXIS 07+ / EXTENT ∈ [0,1]^n',
    role: 'epilogue',
    // Names the same number as the exhibit it lands on (POLYTOPE, cube, n=7).
    // `src/tests/content.test.ts` holds the two sides to that promise.
    cta: 'Begin at the seventh',
    text: {
      title: 'From here, it is your turn',
      body:
        'Dimension does not end at six. Seven, ten, and everything past them are already there, under the very same rule — ' +
        'it is only that we have run out of names. ' +
        'From here on, it is yours to explore.',
    },
  },
];

/* --------------------------------------------------------------------- GALLERY */

/**
 * The exhibits, in the same order as `EXHIBIT_REGISTRY` in `core/gallery.ts`
 * (the registry, not this list, defines the route — but a reader going down
 * this file should not learn the wrong one).
 *
 * The codex layer keeps the discipline of the Japanese original:
 *   - the first sentence must produce a “wait, what” — hook is a question or a paradox
 *   - one analogy per exhibit, never mixed
 *   - quests point at controls that actually exist, named exactly as the panel names them
 *   - the numbers are real (1,200 fibers, 1,024 vertices) — never rounded into vagueness
 */
const EXHIBITS: readonly ExhibitInfo[] = [
  {
    id: 'polytope',
    en: 'POLYTOPE EXPLORER',
    sub: 'Regular polytopes, 3D to 10D',
    tagline: 'From n = 3 to 10 — only the rule goes on',
    codex: {
      hook: 'What happens if you keep adding directions to a die? We are going to count, all the way to ten dimensions.',
      intro:
        'Lift a square and you have a cube. Push the cube along a fourth direction and you have a tesseract. ' +
        'The eye stops keeping up, but the rule continues perfectly. ' +
        'Here you can turn that rule with your own hands, out to ten dimensions.',
      metaphorTitle: 'Shadow play with wire',
      metaphor:
        'Shine a lamp on a cube bent out of wire and the wall shows a warped quadrilateral — a shadow always has one dimension fewer than the thing itself. ' +
        'What you are looking at now is the shadow that wirework of four or more dimensions casts on a three-dimensional wall. ' +
        'The small cube inside is not shrinking. It is only farther from the lamp.',
      observe: [
        'The edges look slightly curved, and that is not an error. A straight edge in high dimensions really does bend on its way into a shadow',
        'Colour is depth along the hidden directions. Vertices of the same colour sit at the same height on an axis you cannot see',
        'However long it turns, the way the faces join never breaks — the structure survives the fall into shadow',
      ],
      quests: [
        {
          title: 'Take N to 10',
          body:
            '1,024 vertices, 5,120 edges. Every direction you add doubles the vertex count — ' +
            'witness exponential violence with your own eyes.',
        },
        {
          title: 'Switch the family to simplex',
          body:
            'You get the figure built from the fewest possible parts. Every vertex joins directly to every other vertex — ' +
            'a shape made entirely of perfect friendships.',
        },
        {
          title: 'Switch the projection to orthographic',
          body:
            'Depth drops away and the shadow turns into a blueprint. Compare them: the edges that curved a moment ago come back straight.',
        },
      ],
      stats: [
        { label: 'RANGE', value: '3D → 10D' },
        { label: 'MAX', value: '1,024 vertices / 5,120 edges' },
        { label: 'ALIVE', value: 'Past 5D, only 3 families remain' },
        { label: 'RULE', value: 'Each added dimension doubles the vertices' },
      ],
    },
    explanation:
      '<p>There are exactly five regular solids in three dimensions and six in four. From the fifth dimension onward, ' +
      'only <em>three</em> families survive — the hypercube (<em>n</em>-cube), the simplex (<em>n</em>-simplex) and the ' +
      'orthoplex (<em>n</em>-orthoplex). Only these three exist in every dimension; the exceptional beauty runs out at four.</p>' +
      '<p>The numbers, however, stay exact for ever. An <em>n</em>-cube has <em>2<sup>n</sup></em> vertices and ' +
      '<em>n·2<sup>n−1</sup></em> edges. An <em>n</em>-simplex joins all <em>n+1</em> of its vertices in every possible pair, ' +
      'and an <em>n</em>-orthoplex takes the <em>2n</em> vertices placed at the positive and negative end of each axis and ' +
      'joins all of them except the opposite pairs. Long after the mind stops forming a picture, the rule goes on.</p>' +
      '<p>What you see here is a <em>cascaded perspective projection</em>. It drops from <em>n</em> dimensions to three ' +
      'one stage at a time, enlarging what is near and shrinking what is far at every stage. The small cube inside a tesseract ' +
      'is not shrinking — it is simply farther away along the fourth direction.</p>' +
      '<p>That the edges look <em>slightly curved</em> is not an artefact of the drawing. Successive perspective divisions do not ' +
      'carry straight lines to straight lines, so a straight edge in high dimensions is <em>correctly</em> drawn as a curve in three. ' +
      'That is why every edge is subdivided and projected point by point. The colour is the last axis lost to the projection — ' +
      'depth in a hidden dimension, read back to you as the colour of the light.</p>',
  },
  {
    id: 'perspective',
    en: 'PERSPECTIVE',
    sub: 'Observer dimension selector',
    tagline: 'To a tesseract, you are a two-dimensional being',
    codex: {
      hook: 'In front of a tesseract, you are a “two-dimensional being.”',
      intro:
        'Show a cube to someone who lives in a plane and all they get is a cross-section changing shape. ' +
        'We are in exactly the same position: a four-dimensional body reaches us only as a section or a shadow. ' +
        'Here you choose the dimension of the seer and of the seen, and feel that unseeability from the inside.',
      metaphorTitle: 'A world at the waterline',
      metaphor:
        'Suppose the surface of the sea were the whole of the world. As a whale rises from below, ' +
        'a small circle appears on the surface, swells wide, and finally vanishes. No inhabitant of that surface will ever see the whole whale — ' +
        'and yet, from the way the circle changes, they can reason their way to its shape.',
      observe: [
        'The main view is exactly the world an inhabitant of that dimension sees',
        'The small window is the god view — a glimpse, from one dimension higher, of what is actually going on',
        'In the X-ray view, everything inside a closed box is visible. Seen from above, a wall stops being a wall',
      ],
      quests: [
        {
          title: 'Press “a flatlander sees a cube”',
          body:
            'A triangle becomes a quadrilateral, becomes a hexagon, and is gone. This is what a cube looks like to an inhabitant of the plane — ' +
            'the whole never arrives.',
        },
        {
          title: 'Press “we see a tesseract”',
          body:
            'Now it is your turn to be baffled by a solid that will not hold its shape. This is where you find out why you cannot laugh at that flatlander.',
        },
        {
          title: 'Press “seeing with four-dimensional eyes”',
          body:
            'The inside of the cube shows straight through. To a four-dimensional viewpoint, the door of a safe means — nothing at all.',
        },
      ],
      stats: [
        { label: 'WAYS', value: 'Only 3 ways to look across' },
        { label: 'ORIGIN', value: '1884, “Flatland”' },
        { label: 'RULE', value: 'm ≠ n — no one sees their own dimension' },
        { label: 'X-RAY', value: 'From above, a closed box is transparent' },
      ],
    },
    explanation:
      '<p>In 1884 Edwin Abbott drew a world made only of a plane. When a sphere visits it, its inhabitants see nothing but a circle ' +
      'changing size. The sphere tells them to come <em>up</em>, but that direction is not in their vocabulary. ' +
      'The fable is still the common language for talking about dimension.</p>' +
      '<p>There are only three ways to look across dimensions. The <em>cross-section</em> — the cut made at the moment a body passes ' +
      'through your world. The <em>shadow</em> — a projection that drops a dimension. And the <em>X-ray view</em> — looking down from ' +
      'one dimension higher. The first two peer up at a higher dimension from a lower one; only the last faces the other way.</p>' +
      '<p>And the position we occupy with respect to a tesseract is exactly the position a flatlander occupies with respect to a cube. ' +
      'All that arrives is a section or a shadow; the whole never comes into an image. Even so, the way the section changes is enough to ' +
      'name the original shape — just as they can reason their way from the swelling of a circle to a sphere.</p>' +
      '<p>Turn it around and nothing closed is closed to the dimension above. To an inhabitant of the plane, a walled room is an absolute ' +
      'inside; we look straight down on it, floor plan and all. Say the same thing from a four-dimensional viewpoint and — ' +
      'a wall, the door of a safe, skin: not one of them is a barrier.</p>',
  },
  {
    id: 'clifford',
    en: 'CLIFFORD TORUS',
    sub: 'The flat torus in S³',
    tagline: 'A torus that is nowhere curved, passing through itself and turning inside out',
    codex: {
      hook: 'This doughnut is not curved anywhere. And every so often — it turns inside out.',
      intro:
        'Make a doughnut in three dimensions and the outside bulges while the inside dips. You cannot close it without bending it. ' +
        'In four dimensions, though, there is a doughnut that closes while staying as flat as graph paper. ' +
        'That is what is turning in front of you.',
      metaphorTitle: 'Graph paper that never tears',
      metaphor:
        'Roll graph paper into a tube — three dimensions manage that much. Bend the tube into a ring and the paper has to stretch ' +
        'or crumple somewhere. Four dimensions have one direction to spare, so the second closure happens without distorting the paper at all. ' +
        'The grid staying square to the very end is the proof.',
      observe: [
        'Everywhere you look, the grid meets at right angles — the distortion belongs to the shadow, not to the surface',
        'Now and then the whole screen is swallowed in light. That is not a fault: it is the torus crossing the edge of the map',
        'Look closely just after it crosses — the face that was inside a moment ago is now the outside',
      ],
      quests: [
        {
          title: 'Take precession to maximum',
          body:
            'The inversions come faster. The screen swells without limit and turns inside out an instant later — catch that instant.',
        },
        {
          title: 'Take both GRID values to 64',
          body: 'The grid grows as fine as cloth, and a surface rises out of what was a gathering of lines.',
        },
        {
          title: 'Take precession to zero',
          body:
            'The inversions stop. The surface only flows along itself, turning for ever without changing shape at all — ' +
            'the quietest state this exhibit has.',
        },
      ],
      stats: [
        { label: 'STAGE', value: 'On a sphere in four dimensions' },
        { label: 'CURVE', value: 'Curvature — zero everywhere' },
        { label: 'SKILL', value: 'Passes through itself and inverts' },
        { label: 'NAME', value: 'W. Clifford (19th century)' },
      ],
    },
    explanation:
      '<p>The Clifford torus is the surface you get by splitting two circles evenly between two orthogonal planes — ' +
      'and it sits exactly on the three-sphere <em>S<sup>3</sup></em>. The two angles stay independent to the end, and the grid meets ' +
      'at right angles everywhere. The intrinsic curvature of this surface is <em>zero</em> at every point. A torus that is not curved.</p>' +
      '<p>It cannot be built in three dimensions. Put a doughnut on a table and the outside bulges while the inside dips — ' +
      'positive and negative curvature always live together. Four dimensions have one more direction, so the two circles never have to ' +
      'push against each other. What you get is a ring with no distortion in it, as though the paper had only been rolled.</p>' +
      '<p>This surface divides <em>S<sup>3</sup></em> exactly in half. What lies on either side of the boundary is a pair of congruent ' +
      'solid tori, each threaded through the other’s hole. A sphere in four dimensions is two doughnuts glued together — you may put it that way.</p>' +
      '<p>A <em>double rotation</em> that turns two independent planes at once only makes the surface flow along itself; the shape does not change. ' +
      'Add a precession that mixes the coordinates and the image begins to swell. At the instant <em>γ = π/4</em> the surface touches the pole of the ' +
      'stereographic projection and the image opens to infinity — and an instant later, inside and outside have traded places. ' +
      'It has passed through itself, and turned inside out.</p>',
  },
  {
    id: 'hopf',
    en: 'HOPF FIBRATION',
    sub: 'Linked circles filling S³',
    tagline: 'A family of circles that fills S³ and never comes apart',
    codex: {
      hook: 'Pick any one ring here — it is linked to every single one of the others.',
      intro:
        'The surface of a sphere in four dimensions turns out to be made of nothing but countless rings. ' +
        'They look scattered, and yet any two you choose are linked exactly once — like a chain. ' +
        'What you are seeing is that whole linkage, cast into three dimensions.',
      metaphorTitle: 'Chain mail',
      metaphor:
        'The mail worn under medieval armour is small rings threaded through one another into a single cloth. ' +
        'This is the cosmic version — except that the rings never cross, and never touch. ' +
        'Linked throughout, and seamless everywhere.',
      observe: [
        'The rings of light lie on the surfaces of doughnuts. The doughnuts nest, layer after layer, from the inside out',
        'A ring that sweeps right across the screen is not broken — it is near the edge of the map. The closer to the edge, the more the shadow is stretched',
        'The whole thing flows without pause, and not once does the linking between rings come undone',
      ],
      quests: [
        {
          title: 'Set the distribution to Fibonacci',
          body:
            'The rings scatter as evenly as sunflower seeds. Then take FIBERS up to its maximum of 1,200 and watch ' +
            'the surface of an invisible sphere fill in with rings.',
        },
        {
          title: 'Turn isoclinic off and move ω₂',
          body:
            'Offset the speeds of the two rotations and the character of the flow changes completely. ' +
            'Only when they match — the isoclinic case — do the rings flow on as rings. It is a rotation only four dimensions have.',
        },
        {
          title: 'Take precession to zero',
          body:
            'The nodding stops and the structure comes quietly into view. Take it to maximum instead and the whole cosmos begins to nod.',
        },
      ],
      stats: [
        { label: 'STAGE', value: 'A sphere in four dimensions' },
        { label: 'RINGS', value: 'Up to 1,200' },
        { label: 'LINK', value: 'Every pair links exactly once' },
        { label: 'SINCE', value: '1931 — H. Hopf' },
      ],
    },
    explanation:
      '<p>Collect every point at the same distance from the origin in four-dimensional space and you have the three-sphere ' +
      '<em>S<sup>3</sup></em>. The Hopf map <em>S<sup>3</sup> → S<sup>2</sup></em> presses this surface — which our eyes will never hold — ' +
      'down onto the familiar sphere. Gather the points that are sent to one and the same place and you find that it is not a point at all: ' +
      'it is a circle.</p>' +
      '<p>That circle is called a <em>fiber</em>. One circle hangs from each point of the base sphere <em>S<sup>2</sup></em>, and together ' +
      'they fill <em>S<sup>3</sup></em> without a gap and without ever meeting — <em>S<sup>1</sup> ↪ S<sup>3</sup> → S<sup>2</sup></em>. ' +
      'Look at any small enough patch and you cannot tell it from a plain product of a sphere with a circle; taken whole, it is never that product. ' +
      'It is twisted.</p>' +
      '<p>Every fiber is a great circle on <em>S<sup>3</sup></em>, and any two of them are linked exactly once. Two rings joined like a chain — ' +
      'the <em>Hopf link</em> — and short of cutting one, they cannot be pulled apart. Each ring of light circling a nested torus on screen ' +
      'is joined to all the others.</p>' +
      '<p>What you see in three dimensions is a shadow made by <em>stereographic projection</em>. Remove a single point — the north pole — ' +
      'from <em>S<sup>3</sup></em> and open the rest out into flat space. The nearer a fiber lies to that pole the more it is stretched, ' +
      'and the one fiber through the pole becomes a straight line of infinite length. The rotation is <em>isoclinic</em> — two mutually ' +
      'orthogonal planes turned at the same angular speed, a motion only four dimensions have. All of <em>S<sup>3</sup></em> flows as though rigid, ' +
      'and every fiber is carried to a fiber. Which is why the picture can flow for ever without the structure breaking once.</p>',
  },
];

/* --------------------------------------------------------------------- POLYTOPE */

/**
 * Proper names for the figures, by family and dimension.
 *
 * **Only 3 and 4 have proper names**, except that the hypercube keeps going
 * with penteract and hexeract at 5 and 6 — and then stops dead. From 7 on,
 * `byNumber` calls them by number instead. That is a decision about the work,
 * not a gap in the dictionary: it is where the epilogue’s “we have run out of
 * names” is performed. A reader who drags N from 6 to 7 watches a name stop
 * being a name. Do not “fix” it by adding a word for 7.
 *
 * `pentachoron` and `hexadecachoron` are used rather than the commoner
 * `5-cell` and `16-cell` for the same reason: at 3 and 4 the figures must have
 * *names*, or the moment the names run out has nothing to run out of.
 */
const CUBE_NAMES: Readonly<Record<number, string>> = {
  3: 'cube',
  4: 'tesseract',
  5: 'penteract',
  6: 'hexeract',
};
const SIMPLEX_NAMES: Readonly<Record<number, string>> = { 3: 'tetrahedron', 4: 'pentachoron' };
const ORTHOPLEX_NAMES: Readonly<Record<number, string>> = {
  3: 'octahedron',
  4: 'hexadecachoron',
};

/**
 * The dimension, spelled out — the counterpart of the Japanese kanji numerals,
 * and set against the digits the counts are printed in (`128 vertices`).
 * Names are language; numbers are arithmetic. Anything past the table falls
 * back to digits, which is the same admission by another route.
 */
const SPELLED: readonly string[] = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
];

/** One spelling of the numerals, used by `byNumber` too — never look the table up twice */
const numeral = (n: number): string => SPELLED[n] ?? String(n);

/** The generic term for each family, used once the proper names run out */
const FAMILY_KIND: Readonly<Record<string, string>> = {
  cube: 'hypercube',
  simplex: 'simplex',
  orthoplex: 'orthoplex',
};

const FAMILY_NAMES: Readonly<Record<string, Readonly<Record<number, string>>>> = {
  cube: CUBE_NAMES,
  simplex: SIMPLEX_NAMES,
  orthoplex: ORTHOPLEX_NAMES,
};

/* ------------------------------------------------------------------ PERSPECTIVE */

/**
 * Captions for the observer-dimension selector.
 *
 * The key is `mode:observer m:target n`; with no exact match, the lookup falls
 * back to `mode` alone. One sentence, saying what is happening on screen right
 * now, in the voice of the chapters — plain words, declarative, one metaphor —
 * and without telling a mathematical lie.
 */
const PERSPECTIVE_CAPTIONS: Readonly<Record<string, string>> = {
  // --- section (looking up at a higher dimension from a lower one) ---
  slice:
    'When a body of higher dimension passes through the world, all its lower-dimensional inhabitants ever see is a single slice.',
  'slice:2:3':
    'To an inhabitant of the plane, a cube is a polygon arriving out of nowhere. A triangle becomes a quadrilateral, becomes a hexagon, and is gone.',
  'slice:3:4':
    'What we three-dimensional beings see is only a section of the tesseract — arriving, swelling, changing shape, going out.',
  'slice:3:5':
    'A five-dimensional solid passes by. Again all that reaches us is a three-dimensional slice — the two hidden directions show up only in how the shape changes.',
  'slice:2:4':
    'A four-dimensional body crosses the plane. What its inhabitants receive is a single polygon that never stops changing — not even a solid.',
  'slice:2:5':
    'Three whole directions fall away at once, from five dimensions down to two. Even so, the slice never takes the same shape twice while the passage lasts.',
  'slice:2:6':
    'One plane’s worth of slice through a six-dimensional body. Even this far down, polygons are still born, still swell, still vanish.',
  'slice:3:6':
    'From six dimensions to three. The solid passing through our world carries the memory of three hidden directions in nothing but the change of its shape.',
  // m=4: the section is four-dimensional, so one more shadow is needed to reach the screen
  'slice:4:5':
    'A four-dimensional inhabitant sees a four-dimensional slice. Drop that to three and it finally fits on this screen — you are seeing the shadow of their view.',
  'slice:4:6':
    'The slice of a six-dimensional body as it appears to four-dimensional eyes. Even to them the whole is invisible — and we only get to peer at the shadow of that view.',
  // m=5: the section is five-dimensional, so two more shadows lie between it and the screen
  'slice:5:6':
    'A five-dimensional inhabitant sees a five-dimensional slice — only one direction is hidden from them. And even that single slice reaches us through two stages of shadow.',
  // --- shadow (a projection that drops a dimension) ---
  shadow:
    'A shadow is the record of a lost dimension. Lengths are distorted, right angles come undone, and still the structure itself remains.',
  'shadow:3:4':
    'The shadow of a tesseract. The small cube inside is not shrinking — it is simply moving away along the fourth direction.',
  'shadow:2:3':
    'The shadow a cube casts on a plane. The six squares do not look square any more.',
  // --- X-ray (looking down at a lower dimension from a higher one) ---
  xray: 'Look down from one dimension higher and everything that ought to be closed is lying open.',
  'xray:3:2':
    'From above, the inside of the house, the layout of its rooms, even the insides of its people, are all visible at once.',
  'xray:4:3':
    'This is how our world looks to four-dimensional eyes. A wall, skin, the door of a safe — not one of them is a barrier.',
  'xray:5:3':
    'Look down from five dimensions and there is nothing further to expose. One dimension up was already enough — being closed had run out by then.',
  'xray:5:2':
    'To five-dimensional eyes, a house in the plane lies open three times over. And still it looks no different than it did from four — what is fully open cannot open further.',
};

/**
 * The line under the title. **This exhibit changes it with the settings**
 * (Phase 40): the thread it follows is *whose eyes you have borrowed, and
 * whether they are enough*.
 *
 * m=3 / n=4 is the entrance, and its line is the core of the exhibit — the
 * claim that a three-dimensional you is effectively a flatlander. Leave it be.
 *
 * **Write no count here.** The set of reachable pairs comes from
 * `ui/perspectiveRange.ts` and nowhere else; a number written into this comment
 * would go quietly stale the next time the range opens up.
 */
const PERSPECTIVE_TAGLINES: Readonly<Record<string, string>> = {
  // --- m=3: seeing from your own dimension ---
  '3:4': 'To a tesseract, you are a two-dimensional being',
  '3:5': 'Before a penteract, your three dimensions are no longer enough',
  '3:6': 'Before a hexeract, being three-dimensional means nothing at all',
  '3:2': 'You are looking down on a world made of plane',
  // --- m=2: borrowing the eyes of a flatlander ---
  '2:3': 'Right now you are an inhabitant of the plane, looking at a cube',
  '2:4': 'Seeing a tesseract through the eyes of a flatlander',
  '2:5': 'How does a penteract look to an inhabitant of the plane',
  '2:6': 'A flatlander’s eyes and six dimensions — nothing could be further apart',
  // --- m=4: borrowing four-dimensional eyes ---
  '4:5': 'Even with four-dimensional eyes, a penteract is still out of reach',
  '4:6': 'Even four-dimensional eyes are two directions short of a hexeract',
  '4:3': 'To four-dimensional eyes, neither wall nor skin is a barrier',
  '4:2': 'To four-dimensional eyes, a world of plane was open from the start',
  // --- m=5: borrowing five-dimensional eyes (Phase 42) ---
  '5:6': 'Even five-dimensional eyes are one direction short of a hexeract',
  '5:3': 'Look down from five dimensions and there is nothing left to open',
  '5:2': 'Five-dimensional eyes and a house in the plane — nothing separates them at all',
};

/* ---------------------------------------------------------------------- UI copy */

/**
 * The shell and the console.
 *
 * Two things to keep in mind when editing:
 *
 * ① **Panel labels lose their second half.** Japanese sets `FAMILY / 族` —
 *    the Latin word to remember the place by, the translation to take the
 *    meaning from. In English the two halves are the same word, so only the
 *    Latin one is written here.
 * ② **Half of each two-part label is empty on purpose.** The design pairs a
 *    line in the reader’s language with a Latin one (`物語 / STORY`,
 *    `ANALOGY / たとえるなら`). In English that would print the same word
 *    twice, so the redundant half is `''` and `style.css` folds it away with
 *    `:empty`. Which half survives differs by place — the nav pill keeps the
 *    large body-font slot, the drawer heading keeps the small mono one — so
 *    read the pair, not the field name.
 */
const UI: Copy['ui'] = {
  doc: {
    title: 'DIMENSION — Seeing Higher Dimensions',
    description:
      'Unseen, and exact — a visualisation of the structures the human eye cannot receive. ' +
      'A scrolling story that extrudes a point in zero dimensions out to a six-dimensional hypercube, ' +
      'and four exhibits including the Hopf fibration.',
    ogDescription:
      'From a point in zero dimensions to a hypercube in six. A scrolling story and four exhibits ' +
      'that show the structure of the dimensions you cannot see.',
    ogImageAlt: 'Rings of light from a stereographically projected Hopf fibration',
  },
  chrome: {
    skipToGallery: 'Skip the story and go to the gallery',
    canvasLabel: 'Real-time visualisation of higher-dimensional figures',
    navLabel: 'Switch mode',
    navNarrative: { text: 'STORY', latin: '' },
    navGallery: { text: 'GALLERY', latin: '' },
    tabsLabel: 'Switch exhibit',
    about: { text: 'ABOUT THIS', latin: '' },
    drawerClose: 'Close the notes',
    qualityLabel: 'Render quality',
  },
  preloader: {
    caption: 'Preparing the dimensions',
    label: 'Loading DIMENSION',
  },
  sound: {
    label: 'Ambience',
    hint: 'Headphones — the beat is not born in the air, but inside your ears.',
  },
  immersive: { label: 'Hide the interface and see only the work' },
  engine: {
    error: 'Graphics failed to initialise. Please reload the page.',
    reload: 'Reload',
  },
  panel: {
    hint: 'CONTROLS',
    toggle: 'Controls (open or close the control panel)',
  },
  drawer: {
    analogy: { text: '', latin: 'ANALOGY' },
    observe: { text: '', latin: 'OBSERVE' },
    tryThis: { text: '', latin: 'TRY THIS' },
    data: { text: '', latin: 'DATA' },
    deepDive: { text: '', latin: 'DEEP DIVE' },
  },
  announce: {
    backToNarrative: 'Back to the story',
    // English reads the Latin display name; `sub` is a sentence of description
    // and too long to hear (see the note on this field in `types.ts`)
    exhibit: (index, total, info) => `Exhibit ${index} of ${total}, ${info.en}`,
  },
  planeCell: (i, j) => `Plane ${i}-${j}`,
  langToggle: {
    // Each language is written in its own script — someone looking for
    // Japanese should find characters they can read
    names: { ja: '日本語', en: 'English' },
    switchTo: (name) => `Switch to ${name}`,
  },
  panels: {
    polytope: {
      family: 'FAMILY',
      families: { cube: 'Hypercube', simplex: 'Simplex', orthoplex: 'Orthoplex' },
      n: 'N',
      projection: 'PROJECTION',
      projections: { perspective: 'Perspective', ortho: 'Orthographic' },
      noteProjection:
        'The edges looking curved is not an error — a straight edge in high dimensions really does bend ' +
        'on its way into a shadow. The colour is depth along the axis that was lost.',
      rotationPlanes: 'ROTATION PLANES',
      planes: 'PLANES (i, j)',
      notePlanes:
        'A filled cell is a plane that is turning; a dotted cell is one that has been stopped — the rotation stops, ' +
        'but the mixing of axes remains. Without it, rotation would never once touch the axes the projection throws away, ' +
        'and those dimensions would drop out of the image entirely (raising n would stop changing the picture). ' +
        'A dashed cell is selected but waiting its turn, held back by the limit on how many planes can turn at once.',
      spin: {
        default: 'Reset',
        depth: 'Favour depth',
        pose: 'Favour the 3D pose',
        all: 'Turn everything',
      },
      spinSummary: (spinning, total, dropped) =>
        dropped > 0 ? `${spinning} / ${total} (${dropped} held back)` : `${spinning} / ${total}`,
    },
    perspective: {
      presetsNote: 'PRESETS',
      presets: {
        flatland: 'A flatlander sees a cube',
        tesseract: 'We see a tesseract',
        fromAbove: 'Seeing with four-dimensional eyes',
      },
      observer: 'OBSERVER m',
      target: 'TARGET n',
      mode: 'MODE',
      modes: { slice: 'Section', shadow: 'Shadow', xray: 'X-ray' },
      rotate: 'ROTATE',
      note:
        'Observer and target cannot be the same dimension (m ≠ n). ' +
        'Peer up from below with a section or a shadow; look down from above with the X-ray view — ' +
        'and you can only look down on worlds of three dimensions or fewer. Every other combination greys out. ' +
        'When the current settings coincide with one of the presets above, that row is marked.',
      godView: 'GOD VIEW',
    },
    clifford: {
      gridU: 'GRID U',
      gridV: 'GRID V',
      isoclinic: 'ISOCLINIC',
      omega1: 'ω₁ / plane (0,1)',
      omega2: 'ω₂ / plane (2,3)',
      precession: 'PRECESSION (0,3)',
      note:
        'Raise the precession and wait: the torus swells to fill the screen — and the instant it passes through, ' +
        'inside and outside trade places and it turns inside out. Not a fault. This is the thing to watch for.',
    },
    hopf: {
      fibers: 'FIBERS',
      distribution: 'DISTRIBUTION',
      distributions: { latitude: 'Latitude', greatCircle: 'Great circle', fibonacci: 'Fibonacci' },
      isoclinic: 'ISOCLINIC',
      omega1: 'ω₁ / plane (0,1)',
      omega2: 'ω₂ / plane (2,3)',
      precession: 'PRECESSION',
      note:
        'Only the rings that were about to become vast lines across the screen are quietly removed. ' +
        'The “breaks” near the poles are what is left of them — at the edge of a map, something always spills over.',
    },
  },
};

/* ---------------------------------------------------------------------- the dict */

export const EN: Copy = {
  // The marquee is Latin decoration in both languages, so it is shared verbatim
  marquee: {
    prologue: 'THE FOURTH DIMENSION IS A DIRECTION — NOT A PLACE — ',
    epilogue: 'EVERY DIMENSION CONTAINS THE LAST — ',
  },
  chapters: CHAPTERS,
  exhibits: EXHIBITS,
  polytope: {
    names: FAMILY_NAMES,
    kinds: FAMILY_KIND,
    fallbackKind: 'polytope',
    numeral,
    byNumber: (n, kind) => `${numeral(n)}-dimensional ${kind}`,
    tagline: (name, vertices, edges) => `${name} — ${vertices} vertices, ${edges} edges`,
  },
  perspective: {
    captions: PERSPECTIVE_CAPTIONS,
    taglines: PERSPECTIVE_TAGLINES,
    taglineFallback: (m, n) =>
      m > n
        ? `Looking down on a ${n}-dimensional world from ${m} dimensions`
        : `Seeing a ${n}-dimensional body with ${m}-dimensional eyes`,
  },
  ui: UI,
};
