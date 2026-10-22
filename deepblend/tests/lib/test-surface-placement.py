#!/usr/bin/env python3
"""Analytic counterexamples and independent dense sampling for world-Z contact."""
import copy
import itertools
import math
from pathlib import Path
import random
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'packages/deepblend/provider-local/python'))
from deepblend_surface_placement import SurfacePlacementError, solve_surface_placement, _compare_translation
from deepblend_util import ActionError


def triangle(xy, z):
    return tuple((x, y, z(x, y) if callable(z) else z) for x, y in xy)


def rectangle(x0, y0, x1, y1, z):
    return [triangle(((x0, y0), (x1, y0), (x1, y1)), z),
            triangle(((x0, y0), (x1, y1), (x0, y1)), z)]


def shift(triangles, offset):
    return [tuple(tuple(p[i] + offset[i] for i in range(3)) for p in t) for t in triangles]


def contains_xy(point, triangle):
    # Independent signed-edge occupancy, used only by a dense sampling oracle.
    signs = []
    for p, q in zip(triangle, triangle[1:] + triangle[:1]):
        signs.append((q[0] - p[0]) * (point[1] - p[1]) - (q[1] - p[1]) * (point[0] - p[0]))
    return min(signs) >= -1e-14 or max(signs) <= 1e-14


class PlacementMathTests(unittest.TestCase):
    def assert_result(self, subject, support, expected, clearance=0, places=10):
        result = solve_surface_placement(subject, support, clearance)
        self.assertAlmostEqual(result['deltaZ'], expected, places=places)
        source = result['subjectContactMeters']
        target = result['supportContactMeters']
        placed = result['placedSubjectContactMeters']
        self.assertAlmostEqual(source[0], target[0], places=places)
        self.assertAlmostEqual(source[1], target[1], places=places)
        self.assertEqual(placed[:2], source[:2])
        self.assertAlmostEqual(placed[2] - target[2], clearance, places=places)
        self.assertAlmostEqual(source[2] + expected, placed[2], places=places)
        return result

    def assert_refusal(self, reason, subject, support, **kwargs):
        with self.assertRaises(SurfacePlacementError) as error:
            solve_surface_placement(subject, support, **kwargs)
        self.assertEqual(error.exception.reason, reason)

    def test_flat_plane_and_clearance(self):
        self.assert_result(rectangle(-1, -1, 1, 1, 2), rectangle(-5, -5, 5, 5, 0), -1.997, .003)

    def test_slope_uses_covered_highest_point(self):
        subject = [triangle(((0, 0), (1, 0), (0, 1)), 5)]
        support = rectangle(-2, -2, 2, 2, lambda x, y: x + 2 * y)
        self.assert_result(subject, support, -3)

    def test_remote_tall_lip_cannot_raise_subject(self):
        support = rectangle(-2, -2, 2, 2, 0) + rectangle(8, 8, 9, 9, 100)
        self.assert_result(rectangle(-.2, -.2, .2, .2, 4), support, -4)

    def test_edge_crossing_is_extremum_not_any_input_vertex(self):
        subject = [triangle(((0, 0), (4, 0), (0, 4)), 5)]
        support = [triangle(((1, -1), (5, 3), (1, 3)), lambda x, y: x)]
        result = self.assert_result(subject, support, -2)
        self.assertEqual(result['supportContactMeters'], [3, 1, 3])

    def test_support_hole_has_no_projected_surface(self):
        ring = (rectangle(-2, -2, 2, -1, 4) + rectangle(-2, 1, 2, 2, 4) +
                rectangle(-2, -1, -1, 1, 4) + rectangle(1, -1, 2, 1, 4))
        self.assert_refusal('no-projected-overlap', rectangle(-.5, -.5, .5, .5, 7), ring)

    def test_vertical_subject_face_is_not_dropped(self):
        subject = [((0, -1, 1), (0, 1, 1), (0, 0, 4))]
        self.assert_result(subject, rectangle(-2, -2, 2, 2, 3), 2)

    def test_vertical_support_face_uses_upper_envelope(self):
        support = [((0, -1, 1), (0, 1, 1), (0, 0, 4))]
        self.assert_result(rectangle(-2, -2, 2, 2, 5), support, -1)

    def test_two_vertical_faces_intersect_in_projected_point(self):
        subject = [((0, -1, 2), (0, 1, 4), (0, 0, 9))]
        support = [((-1, 0, 3), (1, 0, 3), (0, 0, 7))]
        self.assert_result(subject, support, 4)

    def test_all_degenerate_point_triangles(self):
        subject = [((1, 2, 1), (1, 2, 3), (1, 2, 2))]
        support = [((1, 2, 4), (1, 2, 7), (1, 2, 5))]
        self.assert_result(subject, support, 6)

    def test_all_degenerate_line_triangles(self):
        subject = [((0, 0, 2), (2, 2, 4), (1, 1, 3))]
        support = [((1, 1, 7), (3, 3, 7), (2, 2, 7))]
        self.assert_result(subject, support, 4)

    def test_edge_only_and_vertex_only_contact(self):
        subject = [triangle(((0, 0), (1, 0), (0, 1)), 4)]
        self.assert_result(subject, [triangle(((0, 0), (1, 0), (0, -1)), 2)], -2)
        self.assert_result(subject, [triangle(((1, 0), (2, 0), (1, -1)), 2)], -2)

    def test_nonuniform_scale_rotation_world_triangles(self):
        angle = math.pi / 4
        subject = []
        for local in [((0, 0, 0), (1, 0, 0), (0, 1, 0))]:
            world = []
            for x, y, z in local:
                x, y, z = x * 2, y * 3, z * 4
                world.append((1 + x * math.cos(angle) + z * math.sin(angle),
                              2 + y, 10 - x * math.sin(angle) + z * math.cos(angle)))
            subject.append(tuple(world))
        self.assert_result(subject, rectangle(-20, -20, 20, 20, 0), -10 + math.sqrt(2))

    def test_disjoint_triangles_with_overlapping_aabbs(self):
        a = [triangle(((0, 0), (2, 0), (0, 2)), 0)]
        b = [triangle(((2, 2), (2, .9), (.9, 2)), 0)]
        self.assert_refusal('no-projected-overlap', a, b)

    def test_near_miss_is_not_fabricated_as_epsilon_contact(self):
        a = [triangle(((0, 0), (1, 0), (0, 1)), 0)]
        b = [triangle(((1, 1), (1, 1e-14), (1e-14, 1)), 0)]
        self.assert_refusal('no-projected-overlap', a, b)

    def test_skinny_nonzero_projection_retains_extreme(self):
        subject = [((0, 0, 4), (1, 0, 4), (.5, 1e-14, -2))]
        self.assert_result(subject, rectangle(-2, -2, 2, 2, 0), 2)

    def test_candidate_budget_fails_after_partial_maximum(self):
        a = [triangle(((0, 0), (1, 0), (0, 1)), 0)]
        b = a * 2
        self.assert_refusal('candidate-budget-exceeded', a, b, max_candidate_pairs=1)

    def test_broadphase_skips_far_geometry(self):
        a = [triangle(((0, 0), (1, 0), (0, 1)), 2)]
        b = [triangle(((10 + i, 10), (10.5 + i, 10), (10 + i, 10.5)), 999) for i in range(10000)]
        b.append(triangle(((-1, -1), (3, -1), (-1, 3)), 0))
        result = self.assert_result(a, b, -2)
        self.assertEqual(result['statistics']['candidatePairs'], 1)

    def test_proved_z_bounds_skip_high_subject_geometry(self):
        footprint = ((0, 0), (1, 0), (0, 1))
        subject = [triangle(footprint, 0)] + [triangle(footprint, 10 + i) for i in range(10000)]
        support = [triangle(footprint, 2)]
        result = self.assert_result(subject, support, 2)
        self.assertEqual(result['statistics']['candidatePairs'], 1)
        self.assertEqual(result['statistics']['prunedSubjectTriangles'], 10000)

    def test_proved_z_bounds_skip_lower_support_tree_nodes(self):
        footprint = ((0, 0), (1, 0), (0, 1))
        support = [triangle(footprint, -i) for i in range(2000)]
        result = self.assert_result([triangle(footprint, 2)], support, -2)
        self.assertEqual(result['statistics']['candidatePairs'], 1)

    def test_lowest_uncovered_vertex_cannot_prune_later_true_contact(self):
        subject = [triangle(((0, 0), (4, 0), (0, 4)), lambda x, y: 2 * x + 2 * y),
                   triangle(((1.5, 1.5), (1.6, 1.5), (1.5, 1.6)), 2)]
        support = [triangle(((1.4, 1.4), (1.8, 1.4), (1.4, 1.8)), 0)]
        self.assert_result(subject, support, -2)

    def test_uncertified_fast_value_never_drives_z_pruning(self):
        from deepblend_surface_placement import _clip_pair
        a = triangle(((0, 0), (1, 0), (0, 1)), 0)
        b = triangle(((10, 0), (11, 0), (10, 1)), 0)
        support = [triangle(((-1, -1), (3, -1), (-1, 3)), 1),
                   triangle(((9, -1), (13, -1), (9, 3)), 2)]
        def exaggerate(subject_triangle, support_triangle):
            pair = _clip_pair(subject_triangle, support_triangle)
            return (pair[0] + 1000, pair[1], pair[2]) if pair else pair
        with patch('deepblend_surface_placement._clip_pair', side_effect=exaggerate):
            self.assert_result([a, b], support, 2)

    def test_adjacent_float_heights_keep_better_contact(self):
        next_height = math.nextafter(1.0, math.inf)
        subject = [triangle(((0, 0), (1, 0), (0, 1)), 1),
                   triangle(((10, 0), (11, 0), (10, 1)), 1)]
        support = [triangle(((0, 0), (1, 0), (0, 1)), 1),
                   triangle(((10, 0), (11, 0), (10, 1)), next_height)]
        result = solve_surface_placement(subject, support)
        self.assertEqual(result['deltaZ'], next_height - 1)

    def test_independent_rigid_z_translation_covariance(self):
        a = [triangle(((0, 0), (4, 0), (0, 4)), lambda x, y: .3 * x - .7 * y + 5)]
        b = [triangle(((1, -1), (5, 3), (1, 3)), lambda x, y: x + y * .1)]
        baseline = solve_surface_placement(a, b, .005)['deltaZ']
        self.assert_result(shift(a, (0, 0, 7)), shift(b, (0, 0, -4)), baseline - 11, .005)

    def test_vertex_winding_and_order_do_not_change_offset(self):
        examples = [
            (triangle(((0, 0), (4, 0), (0, 4)), 5), triangle(((1, -1), (5, 3), (1, 3)), lambda x, y: x), -2),
            (((0, -1, 2), (0, 1, 4), (0, 0, 9)), ((-1, 0, 3), (1, 0, 3), (0, 0, 7)), 4),
        ]
        for a, b, expected in examples:
            for aa, bb in itertools.product(itertools.permutations(a), itertools.permutations(b)):
                self.assert_result([aa], [bb], expected)

    def test_large_world_offset(self):
        subject = shift([triangle(((0, 0), (4, 0), (0, 4)), 5)], (1e12, -1e12, 1e12))
        support = shift([triangle(((1, -1), (5, 3), (1, 3)), lambda x, y: x)], (1e12, -1e12, 1e12))
        self.assert_result(subject, support, -2, places=3)

    def test_dense_independent_sampling_is_bounded_by_contact(self):
        rng = random.Random(4418)
        for trial in range(16):
            # Two randomly rotated/scaled triangles around a shared interior.
            shapes = []
            for unused in range(2):
                angle = rng.uniform(0, 2 * math.pi)
                radius = rng.uniform(.6, 1.4)
                shapes.append(tuple((radius * math.cos(angle + i * 2 * math.pi / 3),
                                     radius * math.sin(angle + i * 2 * math.pi / 3)) for i in range(3)))
            a = triangle(shapes[0], lambda x, y: -.2 * x + .4 * y + 2)
            b = triangle(shapes[1], lambda x, y: .7 * x - 1.2 * y + .2)
            result = solve_surface_placement([a], [b])
            witness = result['subjectContactMeters']
            self.assertTrue(contains_xy(witness, a))
            self.assertTrue(contains_xy(witness, b))
            self.assertAlmostEqual(witness[2], -.2 * witness[0] + .4 * witness[1] + 2, places=10)
            best_sample = -math.inf
            # Barycentric sampling of subject, occupancy in support; independent
            # height formula does not call any solver interpolation or clipping.
            for i in range(151):
                for j in range(151 - i):
                    u, v = i / 150, j / 150
                    x = a[0][0] * u + a[1][0] * v + a[2][0] * (1 - u - v)
                    y = a[0][1] * u + a[1][1] * v + a[2][1] * (1 - u - v)
                    if contains_xy((x, y), b):
                        best_sample = max(best_sample, .9 * x - 1.6 * y - 1.8)
            self.assertGreaterEqual(result['deltaZ'] + 1e-10, best_sample)
            self.assertLess(result['deltaZ'] - best_sample, .075)

    def test_invalid_nonfinite_and_empty_inputs(self):
        valid = [triangle(((0, 0), (1, 0), (0, 1)), 0)]
        for value in (math.nan, math.inf, -math.inf, True, 10 ** 1000):
            self.assert_refusal('invalid-geometry', [((0, 0, value), (1, 0, 0), (0, 1, 0))], valid)
        self.assert_refusal('invalid-geometry', [], valid)
        self.assert_refusal('invalid-input', valid, valid, clearance_meters=-.001)
        self.assert_refusal('invalid-input', valid, valid, max_candidate_pairs=True)


class SavedGeometryProofTests(unittest.TestCase):
    def fixture(self):
        identity = ('imported-part', 'db_entity__subject', 'MESH', None, None, None)
        return {'hierarchyIdentity': [('db_entity__subject', None, 'EMPTY', None, None, None), identity],
                'metadata': {'rootWorldMatrix': [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]},
                'parts': [{'identity': identity, 'vertices': [(0, 0, 0), (1, 0, 0), (0, 1, 1)],
                           'topology': [(0, 1, 2)]}]}

    def test_actual_world_vertices_prove_saved_translation(self):
        baseline = self.fixture()
        current = copy.deepcopy(baseline)
        current['parts'][0]['vertices'] = [(x, y, z + 3) for x, y, z in baseline['parts'][0]['vertices']]
        current['metadata']['rootWorldMatrix'][2][3] = 3
        self.assertEqual(_compare_translation(baseline, current, [0, 0, 3], 'Subject'), 0)

    def test_noncontact_vertex_change_is_rejected(self):
        baseline = self.fixture()
        current = copy.deepcopy(baseline)
        current['parts'][0]['vertices'][2] = (0, 1, 1.001)
        with self.assertRaises(ActionError) as error:
            _compare_translation(baseline, current, [0, 0, 0], 'Support')
        self.assertEqual(error.exception.code, 'SCENE_VALIDATION_FAILED')

    def test_changed_topology_or_hierarchy_cannot_pass_vertex_match(self):
        baseline = self.fixture()
        topology = copy.deepcopy(baseline)
        topology['parts'][0]['topology'] = [(0, 2, 1)]
        hierarchy = copy.deepcopy(baseline)
        hierarchy['hierarchyIdentity'] = hierarchy['hierarchyIdentity'][:1]
        for changed in (topology, hierarchy):
            with self.assertRaises(ActionError):
                _compare_translation(baseline, changed, [0, 0, 0], 'Subject')

    def test_preserved_vertices_do_not_hide_changed_root_scale(self):
        baseline = self.fixture()
        current = copy.deepcopy(baseline)
        current['metadata']['rootWorldMatrix'][0][0] = 2
        with self.assertRaises(ActionError):
            _compare_translation(baseline, current, [0, 0, 0], 'Subject')

    def test_subtolerance_error_is_reported_without_rounding_digest(self):
        baseline = self.fixture()
        current = copy.deepcopy(baseline)
        current['parts'][0]['vertices'][0] = (0, 0, .000003)
        self.assertEqual(_compare_translation(baseline, current, [0, 0, 0], 'Subject'), .000003)


if __name__ == '__main__':
    unittest.main(verbosity=2)
