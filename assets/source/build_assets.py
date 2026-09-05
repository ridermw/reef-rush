"""Original Reef Rush meshes, authored in game meters (+Y up, +Z forward).

Blender 4.5 LTS only. No model, texture, font, decoder or network inputs.
Run through npm run assets:generate; see ASSET-LICENSE.md for the contract.
"""

import argparse
import json
import math
from pathlib import Path
import random
import struct
import sys

import bpy
from mathutils import Vector


SOURCE = Path(__file__).resolve().parent
DATA = json.loads((SOURCE / "sunlit-assets.json").read_text(encoding="utf-8"))
RNG = random.Random(DATA["seed"])
DECORATION = {"version": 1, "role": "decoration", "collides": False}


def blender_vector(game):
    # Rotation of the authoring basis, not a reflection: exporter reverses it.
    return (game[0], -game[2], game[1])


def material(name, color):
    def linear(channel):
        return channel / 12.92 if channel <= 0.04045 else ((channel + 0.055) / 1.055) ** 2.4

    rgb = [linear(int(color[i:i + 2], 16) / 255) for i in (1, 3, 5)]
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*rgb, 1)
    bsdf.inputs["Metallic"].default_value = 0
    bsdf.inputs["Roughness"].default_value = 0.72
    mat.diffuse_color = (*rgb, 1)
    return mat


def mesh(name, vertices, faces, materials, smooth=True):
    data = bpy.data.meshes.new(name)
    data.from_pydata([blender_vector(v) for v in vertices], [], faces)
    data.update()
    for mat in materials:
        data.materials.append(mat)
    # All authored surfaces are closed; make outward winding deterministic.
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(data)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(data)
    bm.free()
    for polygon in data.polygons:
        polygon.use_smooth = smooth
    return data


def instance(name, data, position=(0, 0, 0), extras=DECORATION):
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = blender_vector(position)
    obj["reefRush"] = extras
    return obj


def ellipsoid(rx, ry, rz, segments=24, rings=12):
    vertices = [(0, ry, 0)]
    for j in range(1, rings):
        latitude = math.pi * j / rings
        for i in range(segments):
            angle = math.tau * i / segments
            vertices.append((rx * math.sin(latitude) * math.cos(angle),
                             ry * math.cos(latitude),
                             rz * math.sin(latitude) * math.sin(angle)))
    bottom = len(vertices)
    vertices.append((0, -ry, 0))
    faces = []
    for i in range(segments):
        n = (i + 1) % segments
        faces.append((0, 1 + i, 1 + n))
        faces.append((bottom, bottom - segments + n, bottom - segments + i))
    for j in range(rings - 2):
        a = 1 + j * segments
        b = a + segments
        for i in range(segments):
            n = (i + 1) % segments
            faces.append((a + i, b + i, b + n, a + n))
    return vertices, faces


def box(half):
    x, y, z = half
    return (
        [(-x, -y, -z), (x, -y, -z), (x, y, -z), (-x, y, -z),
         (-x, -y, z), (x, -y, z), (x, y, z), (-x, y, z)],
        [(0, 1, 2, 3), (4, 7, 6, 5), (0, 4, 5, 1),
         (3, 2, 6, 7), (0, 3, 7, 4), (1, 5, 6, 2)],
    )


def append_geometry(target, geometry, offset=(0, 0, 0)):
    vertices, faces = target
    new_vertices, new_faces = geometry
    base = len(vertices)
    vertices.extend(tuple(v[i] + offset[i] for i in range(3)) for v in new_vertices)
    faces.extend(tuple(base + index for index in face) for face in new_faces)


def branch(start, end, radius, tip, sides=8):
    a, b = Vector(start), Vector(end)
    axis = (b - a).normalized()
    tangent = axis.cross(Vector((0, 0, 1))).normalized()
    bitangent = axis.cross(tangent).normalized()
    vertices = []
    for center, r in [(a, radius), (b, tip)]:
        for i in range(sides):
            angle = math.tau * i / sides
            vertices.append(tuple(center + r * (math.cos(angle) * tangent + math.sin(angle) * bitangent)))
    faces = [tuple(reversed(range(sides))), tuple(range(sides, 2 * sides))]
    for i in range(sides):
        n = (i + 1) % sides
        faces.append((i, n, n + sides, i + sides))
    return vertices, faces


def leaf(points, thickness=0.025):
    # Closed thin prism, so fins and leaves remain visible from either side.
    vertices = [(x, y, z - thickness) for x, y, z in points]
    vertices += [(x, y, z + thickness) for x, y, z in points]
    n = len(points)
    faces = [tuple(reversed(range(n))), tuple(range(n, 2 * n))]
    faces += [(i, (i + 1) % n, (i + 1) % n + n, i + n) for i in range(n)]
    return vertices, faces


def fin(name, yz, pivot, mat):
    vertices = [(side, y, z) for side in (-0.012, 0.012) for y, z in yz]
    n = len(yz)
    faces = [tuple(reversed(range(n))), tuple(range(n, n * 2))]
    faces += [(i, (i + 1) % n, (i + 1) % n + n, i + n) for i in range(n)]
    return instance(name, mesh(name, vertices, faces, [mat], False), pivot,
                    {"version": 1, "role": "fish-part", "collides": False})


def fish(palette):
    body = mesh("sunfin-body", *ellipsoid(0.21, 0.29, 0.86, 32, 16),
                [palette["sunfin-orange"], palette["sunfin-cream"]])
    for polygon in body.polygons:
        # Blender local Z is game Y.
        if sum(body.vertices[i].co.z for i in polygon.vertices) / len(polygon.vertices) < -0.08:
            polygon.material_index = 1
    fish_extras = {"version": 1, "role": "fish-part", "collides": False}
    instance("sunfin-body", body, extras=fish_extras)
    for side, sign in [("left", -1), ("right", 1)]:
        eye = mesh("eye", *ellipsoid(0.043, 0.080, 0.080, 16, 8), [palette["sunfin-cream"]])
        instance("sunfin-eye-" + side, eye, (sign * 0.164, 0.10, 0.56), fish_extras)
        pupil = mesh("pupil", *ellipsoid(0.027, 0.048, 0.048, 16, 8), [palette["eye-ink"]])
        instance("sunfin-pupil-" + side, pupil, (sign * 0.197, 0.105, 0.58), fish_extras)
    tail = fin("fin-tail", [(0, 0.06), (0.37, -0.55), (0, -0.42), (-0.37, -0.55)],
               (0, 0, -0.74), palette["sunfin-orange"])
    fin("fin-dorsal", [(0, 0.32), (0.31, -0.04), (0.12, -0.55), (0, -0.48)],
        (0, 0.23, 0.10), palette["sunfin-teal"])
    fin("fin-anal", [(0, 0.10), (-0.19, -0.28), (0, -0.40)],
        (0, -0.23, -0.16), palette["sunfin-cream"])
    animated = [(tail, 2, 0.27)]
    for side, sign in [("left", -1), ("right", 1)]:
        vertices, faces = leaf([(0, 0, 0.06), (sign * 0.33, -0.13, -0.17),
                                (sign * 0.21, -0.17, -0.40), (0, -0.03, -0.21)], 0.009)
        obj = instance("fin-pectoral-" + side,
                       mesh("pectoral-" + side, vertices, faces, [palette["sunfin-orange"]], False),
                       (sign * 0.18, -0.06, 0.12), fish_extras)
        animated.append((obj, 1, sign * 0.23))
    for obj, axis, amplitude in animated:
        obj.rotation_mode = "XYZ"
        for frame, wave in [(1, 0), (7, 1), (13, 0), (19, -1), (25, 0)]:
            obj.rotation_euler[axis] = amplitude * wave
            obj.keyframe_insert(data_path="rotation_euler", frame=frame)
    bpy.context.scene.frame_set(1)


def reef_meshes(palette):
    result = {}
    result["limestone"] = mesh("limestone", *ellipsoid(1.1, 0.65, 0.85, 12, 8),
                               [palette["limestone"]], False)
    geometry = ([], [])
    append_geometry(geometry, branch((0, 0, 0), (0, 1.7, 0), 0.16, 0.07))
    for i in range(9):
        angle = i * 2.4
        height = 0.35 + i * 0.135
        tip = (math.cos(angle) * 0.68, height + 0.6, math.sin(angle) * 0.52)
        append_geometry(geometry, branch((0, height, 0), tip, 0.09, 0.04))
        append_geometry(geometry, branch(tip, (tip[0] * 1.12, tip[1] + 0.28, tip[2] * 1.08),
                                         0.04, 0.018))
    result["coral-peach"] = mesh("coral-peach", *geometry, [palette["coral-peach"]])
    geometry = ([], [])
    append_geometry(geometry, branch((0, 0, 0), (0, 1.0, 0), 0.07, 0.03))
    for i in range(11):
        angle = -1.20 + i * 0.24
        end = (math.sin(angle) * 1.05, 0.75 + math.cos(angle) * 1.25, 0.12 * math.sin(i))
        append_geometry(geometry, branch((0, 0.45, 0), end, 0.04, 0.014, 6))
        if i:
            prev = (math.sin(angle - 0.24) * 1.05, 0.75 + math.cos(angle - 0.24) * 1.25, 0.12 * math.sin(i - 1))
            for t in (0.55, 0.8, 1.0):
                a = tuple((0.45 if j == 1 else 0) * (1 - t) + end[j] * t for j in range(3))
                b = tuple((0.45 if j == 1 else 0) * (1 - t) + prev[j] * t for j in range(3))
                append_geometry(geometry, branch(a, b, 0.013, 0.013, 5))
    result["coral-lavender"] = mesh("coral-lavender", *geometry, [palette["coral-lavender"]])
    geometry = ([], [])
    for i in range(7):
        x = (i - 3) * 0.105
        height = 0.8 + RNG.random() * 0.65
        bend = (RNG.random() - 0.5) * 0.5
        append_geometry(geometry, leaf([(x - 0.05, 0, 0), (x + 0.07, height * 0.5, 0.05),
                                       (x + bend, height, 0.18), (x - 0.05, height * 0.5, 0.06)]))
    result["seagrass-jade"] = mesh("seagrass-jade", *geometry, [palette["seagrass-jade"]])
    return result


def course(palette, props, collision):
    for solid in DATA["solids"]:
        shape = {"type": solid["type"]}
        if solid["type"] == "box":
            shape["halfExtents"] = solid["halfExtents"]
            geometry = box(solid["halfExtents"])
        else:
            shape["radius"] = solid["radius"]
            geometry = ellipsoid(*([solid["radius"]] * 3))
        extras = {
            "version": 1, "role": "static-solid", "id": solid["id"],
            "category": solid["collision"], "primitive": shape,
            "transform": {"position": solid["position"], "rotation": solid.get("rotation", [0, 0, 0, 1]),
                          "scale": [1, 1, 1]},
        }
        mat = material(solid["id"], solid["color"])
        obj = instance(solid["id"], mesh(solid["id"], *geometry, [mat], solid["type"] == "sphere"),
                       solid["position"], extras)
        q = extras["transform"]["rotation"]
        obj.rotation_mode = "QUATERNION"
        obj.rotation_quaternion = (q[3], q[0], -q[2], q[1])
    if collision:
        return
    for i, (x, y, z) in enumerate(DATA["reefClusters"]):
        for j, (name, data) in enumerate(props.items()):
            instance(f"decor-{i:02}-{name}", data, (x + (j % 2) * 1.8, y, z + (j // 2) * 2.1))
    terrace = mesh("sand-terrace", *box((2.8, 0.20, 4.5)), [palette["limestone"]], False)
    for i, z in enumerate([4, 18, 45, 58, 83, 100]):
        instance(f"decor-terrace-{i}", terrace, ((-1 if i % 2 else 1) * 18, -7.8, z))


def export_asset(root, relative, build, animated=False):
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    scene = bpy.context.scene
    scene.name = "swim" if animated else "Reef Rush"
    scene.frame_start, scene.frame_end = 1, 25
    scene.render.fps = 24
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1
    scene["reefRush"] = {
        "profile": "reef-rush-original-v1", "asset": relative, "up": "+Y", "forward": "+Z",
        "metersPerUnit": 1, "seed": DATA["seed"],
    }
    build()
    target = root / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(target), export_format="GLB", export_yup=True,
        export_extras=True, export_cameras=False, export_lights=False,
        export_materials="EXPORT", export_texcoords=False, export_normals=True,
        export_animations=animated, export_animation_mode="SCENE",
        export_anim_scene_split_object=False, export_anim_slide_to_zero=True,
        export_force_sampling=True,
        export_frame_range=True, export_frame_step=1, export_skins=False,
        export_morph=False, export_all_influences=False,
    )
    # Canonical JSON serialization; binary payload remains Blender's export.
    raw = target.read_bytes()
    size = struct.unpack_from("<I", raw, 12)[0]
    document = json.loads(raw[20:20 + size])
    document["asset"]["generator"] = "Reef Rush original-v1 / Blender 4.5 LTS"
    if animated:
        if len(document.get("animations", [])) != 1:
            raise ValueError("Expected a single scene swim animation")
        document["animations"][0]["name"] = "swim"
    encoded = json.dumps(document, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    encoded += b" " * (-len(encoded) % 4)
    binary_chunk = raw[20 + size:]
    target.write_bytes(struct.pack("<III", 0x46546C67, 2, 20 + len(encoded) + len(binary_chunk))
                       + struct.pack("<II", len(encoded), 0x4E4F534A) + encoded + binary_chunk)
    print(f"ORIGINAL_ASSET {relative} {target.stat().st_size} bytes")


def main():
    if bpy.app.version[:2] != (4, 5):
        raise RuntimeError("Use Blender 4.5 LTS for this reproducible asset profile")
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-root", type=Path, default=SOURCE.parent.parent / "public" / "assets")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    palette = {name: material(name, color) for name, color in DATA["palette"].items()}
    props = reef_meshes(palette)
    export_asset(args.output_root, "fish/sunfin.glb", lambda: fish(palette), True)
    export_asset(args.output_root, "props/reef-kit.glb",
                 lambda: [instance(name, data, (i * 3, 0, 0)) for i, (name, data) in enumerate(props.items())])
    export_asset(args.output_root, "courses/sunlit-shoals.visual.glb", lambda: course(palette, props, False))
    export_asset(args.output_root, "courses/sunlit-shoals.collision.glb", lambda: course(palette, props, True))


if __name__ == "__main__":
    main()
