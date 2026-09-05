# Asset License

All source code in this repository is licensed separately under the MIT License in `LICENSE`.

Unless a future file or directory states otherwise, first-party non-code assets for Reef Rush are
copyright (c) 2026 Matthew W. Rider and licensed under the Creative Commons Attribution 4.0
International license (CC BY 4.0). That includes original art, audio, animation, user-interface
illustrations, narrative text presented as game content, captured media, and marketing assets.

You may share and adapt those first-party assets for any purpose, including reuse outside Reef
Rush, provided you give appropriate attribution, indicate whether changes were made, and do not
imply endorsement by the original creator.

Third-party assets, tools, fonts, and dependency packages remain under their own respective
licenses and notices.

## Original Sunlit assets (Task 9, Slice 9A)

The four GLBs below are first-party artwork, authored procedurally for Reef Rush
from original mesh construction, palette, proportions, branch patterns and
animation in `assets/source/build_assets.py` and
`assets/source/sunlit-assets.json`. No third-party models, textures, images,
fonts, scans or animation clips are incorporated. Blender is an authoring tool,
not an artwork source. The editable Python generator is MIT-licensed source
code; the JSON art data and generated artwork are CC BY 4.0 as stated above.
No `.blend` archive is needed to edit or reproduce the artwork.

| Output under `public/assets/`         | Original content                                                          |
| ------------------------------------- | ------------------------------------------------------------------------- |
| `fish/sunfin.glb`                     | Orange/cream Sunfin, teal dorsal fin, eyes, separate fins and `swim` loop |
| `props/reef-kit.glb`                  | Warm limestone, branching peach coral, lavender fan and jade seagrass     |
| `courses/sunlit-shoals.visual.glb`    | Five authored solid bases, shared reef props and low sand terraces        |
| `courses/sunlit-shoals.collision.glb` | Only the five named primitive proxy meshes; no decorative mesh physics    |

Suggested attribution: **"Reef Rush original Sunlit assets, copyright (c) 2026
Matthew W. Rider, CC BY 4.0; changes: [describe any changes]."**

## Original Kelpworks assets (Task 11, Slice 11B)

`assets/source/kelpworks-assets.json` and the same original Python generator
author a separate marine kelp grove, not a coral reskin or imported model.
Three shared, merged mesh variants combine closed tapered fronds, curved
stipes and branching holdfast roots. Thirty grove instances use dark jade
(`#244e3b`), olive (`#61733d`) and golden (`#a99b4d`) materials. Each variant
has one primitive/material, preserving a flat mesh-only export scene rather
than a hierarchy or one object per leaf. All fronds are static.

| Output under `public/assets/`     | Original content                                                  |
| --------------------------------- | ----------------------------------------------------------------- |
| `courses/kelpworks.visual.glb`    | Seven authored solid bases and thirty shared kelp grove instances |
| `courses/kelpworks.collision.glb` | Only the seven named primitive proxy meshes; no kelp decoration   |

Kelpworks reuses the unchanged `fish/sunfin.glb` lease and swim animation.
Runtime reduced-effects controls still govern the fish and particles; the
static kelp requires no animation or additional decoder. No external models,
textures, fonts, skins, morph targets or downloaded artwork are incorporated.
The JSON art data and generated GLBs are CC BY 4.0; the generator is MIT.

Suggested attribution: **"Reef Rush original Kelpworks assets, copyright (c)
2026 Matthew W. Rider, CC BY 4.0; changes: [describe any changes]."**

## Original Blacksmoker assets (Task 12, Slice 12B)

`assets/source/blacksmoker-assets.json` and the same original Python generator
author volcanic chimney/mineral clusters from simple original geometry.
Three shared, merged variants combine faceted tapered chimneys, closed rims
with recessed vent wells, mineral spurs and low basalt foundations. Thirty
static side placements use dark basalt (`#27343b`), copper (`#a86542`) and
sulfur (`#c4ac59`) against the course's deep blue water. Each variant is one
mesh with one primitive/material; there is no animated smoke or new mechanic.

| Output under `public/assets/`           | Original content                                                          |
| --------------------------------------- | ------------------------------------------------------------------------- |
| `courses/blacksmoker-run.visual.glb`    | Nine authoritative solid bases and thirty shared chimney/mineral clusters |
| `courses/blacksmoker-run.collision.glb` | Only the nine named primitive proxy meshes; no decorative collisions      |

Blacksmoker reuses the unchanged Sunfin mesh and swim animation. The source
solids reproduce the authored course's exact geometry and colors; dynamic
gates, currents, checkpoints and pearls remain runtime owned. No downloaded
artwork, models, textures, decoders, skins or morph targets are incorporated.
The JSON art data and generated GLBs are CC BY 4.0; the generator is MIT.
These construction and measurement claims are not human assessments of
visual quality or gameplay feel.

Suggested attribution: **"Reef Rush original Blacksmoker assets, copyright (c)
2026 Matthew W. Rider, CC BY 4.0; changes: [describe any changes]."**

### Measured eight-asset set

Measurements use Blender 4.5.13 LTS and the original-v1 validator. Triangles
count every placed instance, including shared meshes.

| Output under `public/assets/`           |       Bytes |  Triangles | Mesh nodes | Static solids |
| --------------------------------------- | ----------: | ---------: | ---------: | ------------: |
| `fish/sunfin.glb`                       |      45,008 |      1,912 |         10 |             0 |
| `props/reef-kit.glb`                    |      41,264 |      1,512 |          4 |             0 |
| `courses/sunlit-shoals.visual.glb`      |      78,696 |     19,824 |         59 |             5 |
| `courses/sunlit-shoals.collision.glb`   |      28,764 |      1,608 |          5 |             5 |
| `courses/kelpworks.visual.glb`          |     110,388 |     42,948 |         37 |             7 |
| `courses/kelpworks.collision.glb`       |      37,512 |      2,148 |          7 |             7 |
| `courses/blacksmoker-run.visual.glb`    |     144,384 |     21,372 |         39 |             9 |
| `courses/blacksmoker-run.collision.glb` |      40,784 |      2,172 |          9 |             9 |
| **Total**                               | **526,800** | **93,496** |    **170** |        **42** |

### Reproduction

Use the repository's pinned Node version and Blender **4.5 LTS**. The initial
outputs use **Blender 4.5.13 LTS**. The generator rejects other Blender major/minor
versions. Fixed seed: `9042026`. Run from the project root:

```text
npm run assets:generate
npm run assets:generate -- --blender "<Blender executable>" --output-root "<output assets directory>"
npm run assets:validate
npm run assets:validate -- --asset-root "<output assets directory>"
npm run test -- tests/assets/assetPipeline.test.ts
```

The executable defaults to `blender`, or the optional `BLENDER` environment
variable. The output root contains the `fish`, `props` and `courses` directories.
The runner always passes `--background --factory-startup --python-exit-code 1`
before `--python`, propagates Blender failures and validates its outputs.
It generates all eight files. The original four exports retain their original
Blender call order; Kelpworks materials and mesh datablocks are created only
after those exports, preserving the reviewed Sunlit/fish/prop bytes.
Blacksmoker materials and mesh datablocks are created only after all six
previous outputs. Generate into a separate output directory and compare the
six existing files byte-for-byte before copying only the new Blacksmoker pair;
do not overwrite previous artwork or update its reviewed hash baselines.
No UI, network, decoder or image resource is required. Tool installations and
absolute machine paths do not belong in the repository.
Unit tests and normal validation load the repository GLBs and do not require
Blender. Only explicit asset generation requires the authoring tool.

Geometry is constructed in game meters, **+Y up / +Z forward**, rotated into
Blender's authoring basis as `(x, -z, y)`, then exported with glTF Y-up enabled.
Dimensions are baked into mesh vertices; collider nodes have unit scale.
The exporter slides the sampled one-second fin animation to time zero.
GLB JSON is canonically serialized after export; the binary mesh/animation
payload is Blender's export. Exact binary repeatability is expected for the
same Blender build/platform, not promised across Blender updates or platforms.

### Original asset profile and collider contract

`tools/asset-profile.mjs` is a reusable offline validator.
`tools/asset-profile.d.mts` supplies the typed `StaticSolidExtras`,
`NoncollidingExtras`, `StaticSolidSource` and `AssetReport` contract. It has no
runtime integration. `validateGlb(bytes, assetPath, liveSolids)` accepts the
selected course's typed solids, including their colors. An explicit eight-path
allowlist assigns fish, prop, visual or collision roles and course identity;
unknown paths never receive a fallback profile. `validateAssetSet(assetRoot,
sourcePaths)` requires an exact map with `sunlit-shoals`, `kelpworks` and
`blacksmoker-run` keys,
each pointing to its own JSON source. `courseSourcePaths(projectRoot)` resolves
those portable source filenames; `validateProject` also checks both project
license files. Sources must declare version 1, seed `9042026`, their matching
`courseId`, valid art data and the exact required solid identities/counts.
The focused tests compare all three complete source solid arrays and all six
course outputs to their respective live definitions, preventing silent source
drift or accidental cross-course matching.
The runtime shares the pure `src/game/assets/staticSolidContract.mjs` checks
and validates loaded objects in `validateLoadedCourseAsset.ts`; it does not
import the filesystem based validator into the browser.

Each scene has `extras.reefRush` with `profile: "reef-rush-original-v1"`, its
relative asset path, `up: "+Y"`, `forward: "+Z"`, `metersPerUnit: 1` and `seed`.
The supported glTF 2.0 profile is intentionally narrow: one exhaustive flat
scene; uniquely named mesh nodes; indexed triangles; tightly packed float32
positions/normals; uint16/uint32 indices; opaque lit PBR color materials; and,
only for the fish, linear quaternion animation on the three moving fin nodes.
Geometry and materials are shared between repeated prop instances.

Two GLB chunks (JSON then BIN), a single embedded buffer and valid accessor
ranges/bounds are required. Unsupported features are rejected, not ignored:
external resources, images/textures, all extensions/decoders, skins, morphs,
sparse/interleaved accessors, node matrices/hierarchies, lights and cameras.
Reported triangles and draw calls count **instances**, not just unique meshes;
draw calls are primitive instances before any renderer-specific passes.
Budgets are 2 MiB per GLB, 5 MiB combined, 10,000 fish triangles, 100,000 course
visual triangles and 256 course mesh nodes. The profile also caps the other
nonfish outputs at 100,000 triangles and all outputs at 256 mesh nodes.
Before decoding any accessor values, the validator caps their aggregate at
1,000,000 scalar components per file, including aliased or unused accessors.
Small buffers cannot bypass this work and memory budget through repeated views.

Every static visual base and collision node is named exactly its course ID.
Its `node.extras.reefRush` value follows this versioned discriminated contract:

```json
{
  "version": 1,
  "role": "static-solid",
  "id": "west-ledge",
  "category": "environment",
  "primitive": { "type": "box", "halfExtents": [3, 2, 14] },
  "transform": {
    "position": [-13, -6, 24],
    "rotation": [0, 0, 0, 1],
    "scale": [1, 1, 1]
  }
}
```

The other primitive variant is `{ "type": "sphere", "radius": 4 }`; category is
`"environment"` or `"hazard"`. Rotation is quaternion `[x, y, z, w]`.
This metadata uses **game/glTF coordinates**, not Blender coordinates. Metadata
must match the authored course exactly, including each primitive's material
color; exported float32 transforms, bounds
and primitive surfaces use an absolute `1e-5` tolerance. Local proxy meshes
are centered at the origin with actual primitive dimensions; node translation
and rotation place them in the course. The validator also checks closed proxy
surfaces. Consumers should create primitive colliders from this metadata,
**never detailed coral triangle physics**.

The five Sunlit IDs are `sand-bed`, `west-ledge`, `coral-mound-east`,
`coral-mound-west`, and `urchin-outcrop` (the sole static hazard).
The seven Kelpworks IDs are `kelp-seabed`, `kelp-west-bank`, `kelp-east-bank`,
`kelp-west-roots`, `kelp-east-roots`, `kelp-urchin` (the sole static hazard),
and `kelp-channel-rock`.
The nine Blacksmoker IDs are `smoker-seabed`, `smoker-west-wall`,
`smoker-east-wall`, `smoker-west-root`, `smoker-east-root`,
`smoker-west-chimney`, `smoker-east-chimney`, `smoker-hot-vent` and
`smoker-cinder-vent` (the latter two are static hazards).
Each occurs exactly once in its own course's visual
and collision outputs. Dynamic gates, currents, checkpoints and pearls are
intentionally absent from all static exports.

Decorative nodes instead have exactly
`{ "version": 1, "role": "decoration", "collides": false }`;
fish parts use the same form with `role: "fish-part"`. Course decoration names
start with `decor-`. Per-course decoration ceilings preserve the open
route/spawn ribbon: Sunlit and Kelpworks retain `y = -7.5`; Blacksmoker requires
`y = -12.5` because its authored route descends to `y = -9`. Every decoration
must satisfy `max.x < -9 || min.x > 9 || max.y <= courseCeiling`.
The static guard checks the entire transformed actual mesh bounds, not just
the instance origin. A central Blacksmoker decoration entirely below `-7.5`
but above `-12.5` is rejected, even though it would fit the earlier courses'
shallower exemption. Translation, rotation and scale all affect these bounds.
Kelp grove origins lie at `13 <= abs(x) <= 19`, with fronds outside the ribbon.
Blacksmoker vent clusters are placed on the route sides, with all their
geometry outside the same horizontal ribbon.
This is a visibility/placement guard, not a gameplay or human art-quality assessment.
Named fish nodes include `sunfin-body`, `sunfin-eye-left`, `sunfin-eye-right`,
`fin-tail`, `fin-dorsal`, `fin-anal`, `fin-pectoral-left` and
`fin-pectoral-right`. The tail and both pectoral fins have nonconstant tracks
with matching first/last rotations in the `swim` clip.
