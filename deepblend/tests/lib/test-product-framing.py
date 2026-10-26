"""Perspective-fit counterexamples checked through an independent projection."""
import itertools
import math
from pathlib import Path
import random
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'packages/deepblend/provider-local/python'))
from deepblend_product_framing import fit_perspective_points, canonical_face


class FramingMathTests(unittest.TestCase):
    def assert_fit(self, points, limits=(-.36, .36, -.27, .27), clipping=(.01, 1000), margin=.03):
        before = [list(p) for p in points]
        fit = fit_perspective_points(points, limits, clipping, margin)
        origin = fit['origin']
        # Standard homogeneous perspective projection, independent of the solve.
        l, r, b, t = limits
        matrix = ((2/(r-l), 0, (r+l)/(r-l), 0),
                  (0, 2/(t-b), (t+b)/(t-b), 0),
                  (0, 0, -(clipping[1]+clipping[0])/(clipping[1]-clipping[0]),
                   -2*clipping[1]*clipping[0]/(clipping[1]-clipping[0])),
                  (0, 0, -1, 0))
        for point in points:
            relative = [point[i]-origin[i] for i in range(3)] + [1]
            clip = [sum(a*b for a, b in zip(row, relative)) for row in matrix]
            self.assertGreater(clip[3], clipping[0])
            self.assertLess(clip[3], clipping[1])
            for i in range(2):
                uv = (clip[i]/clip[3]+1)/2
                self.assertGreaterEqual(uv, margin)
                self.assertLessEqual(uv, 1-margin)
        self.assertEqual(before, [list(p) for p in points])
        self.assertEqual(fit['vertexCount'], len(points))
        return fit

    def test_cube_with_depth_and_points_behind_original_camera(self):
        self.assert_fit(list(itertools.product((-1, 1), (-2, 2), (-3, 3))))

    def test_translated_very_thin_geometry(self):
        self.assert_fit([[100, -.7, -10], [100.000001, .1, -10.000002]])

    def test_camera_axis_outside_shifted_frame(self):
        self.assert_fit([[2, 3, 4], [-2, -3, -4]], (1.2, 1.8, -.6, -.1))

    def test_portrait_narrow_angle(self):
        self.assert_fit([[2, 3, 4], [-2, -3, -4]], (-.02, .02, -.06, .06))

    def test_zero_and_maximum_margin(self):
        for margin in [0, .25]:
            self.assert_fit([[2, 3, 4], [-2, -3, -4]], margin=margin)

    def test_degenerate_point_is_still_beyond_near_clip(self):
        self.assert_fit([[0, 0, 0]], clipping=(.3, 100))

    def test_seeded_clouds_shift_aspect_and_depth(self):
        rng = random.Random(20261026)
        for _ in range(100):
            x, y = rng.uniform(-2, 2), rng.uniform(-2, 2)
            width, height = rng.uniform(.01, 2), rng.uniform(.01, 2)
            points = [[rng.uniform(-2, 2), rng.uniform(-2, 2), rng.uniform(-3, 3)] for _ in range(50)]
            self.assert_fit(points, (x-width, x+width, y-height, y+height), margin=rng.uniform(0, .25))

    def test_far_clip_cannot_be_silently_extended(self):
        with self.assertRaisesRegex(ValueError, 'clip range'):
            fit_perspective_points([[-10, -10, -1], [10, 10, 1]], [-.1, .1, -.1, .1], [.1, 1], .03)

    def test_invalid_calibration_and_nonfinite_vertices(self):
        for limits, clipping, margin in [([1, 1, -1, 1], [.1, 10], .03),
                ([-1, 1, -1, 1], [10, 1], .03), ([-1, 1, -1, 1], [.1, 10], .251),
                ([-1, 1, -1, math.inf], [.1, 10], .03)]:
            with self.assertRaises(ValueError):
                fit_perspective_points([[0, 0, -1]], limits, clipping, margin)
        for points in [[], [[math.nan, 0, 0]], [[1e7, 0, 0]], iter([[0, 0, 0]])]:
            with self.assertRaises(ValueError):
                fit_perspective_points(points, [-1, 1, -1, 1], [.1, 10], .03)

    def test_equivalent_face_corner_start_keeps_winding_and_connectivity(self):
        self.assertEqual(canonical_face([3, 4, 1, 2]), canonical_face([1, 2, 3, 4]))
        self.assertNotEqual(canonical_face([1, 2, 3, 4]), canonical_face([4, 3, 2, 1]))
        self.assertNotEqual(canonical_face([1, 2, 3, 4]), canonical_face([1, 3, 2, 4]))


if __name__ == '__main__':
    unittest.main()
