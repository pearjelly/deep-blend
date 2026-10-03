"""Analytic cup surfaces, independent of Blender and mesh tessellation."""
import math

def unit(vector):
    size = math.sqrt(sum(value * value for value in vector))
    if size == 0 or not math.isfinite(size):
        raise ValueError('invalid surface normal')
    return tuple(value / size for value in vector)

def add(a, b):
    return tuple((x + y for (x, y) in zip(a, b)))

def mul(a, s):
    return tuple((x * s for x in a))

def sub(a, b):
    return add(a, mul(b, -1))

def bezier(controls, t):
    n = len(controls) - 1
    return tuple((sum((math.comb(n, i) * (1 - t) ** (n - i) * t ** i * p[k] for (i, p) in enumerate(controls))) for k in range(3)))

class CupSurface:

    def __init__(self, parameters):
        self.P = parameters
        for (key, source) in {'R': 'radius', 'T': 'wall', 'B': 'bottom', 'HEIGHT': 'height', 'C': 'footRound', 'r': 'handleRadius', 'A': 'rootRadius', 'L': 'rootLength', 'N': 'bodySegments', 'M': 'sectionSegments'}.items():
            setattr(self, key, parameters[source])
        self.H = (parameters['upper'] - parameters['lower']) / 2
        self.MID = (parameters['upper'] + parameters['lower']) / 2
        self.TAU = math.tau

    def root_controls(self, theta, upper):
        """Quintic Hermite jets from the cylindrical wall and half-torus surface.

        rho decreases at the wall. At the tube end, alpha increases along the
        outgoing torus (opposite traversal for the lower attachment).
        """
        (ct, st) = (math.cos(theta), math.sin(theta))
        z = self.P['upper'] if upper else self.P['lower']
        q0 = (math.sqrt(self.R * self.R - self.A * self.A * ct * ct), self.A * ct, z + self.A * st)
        speed = self.A - self.r
        d0 = (self.A * speed * ct * ct / q0[0], -speed * ct, -speed * st)
        dd0 = (-speed * speed * ct * ct * self.R * self.R / q0[0] ** 3, 0, 0)
        q1 = (self.R + self.L, self.r * ct, z + self.r * st)
        sign = 1 if upper else -1
        alpha_speed = self.L / self.H
        d1 = (alpha_speed * (self.H + sign * self.r * st), 0, 0)
        dd1 = (0, 0, -sign * alpha_speed ** 2 * (self.H + sign * self.r * st))
        return [q0, add(q0, mul(d0, 0.2)), add(add(q0, mul(d0, 0.4)), mul(dd0, 0.05)), add(sub(q1, mul(d1, 0.4)), mul(dd1, 0.05)), sub(q1, mul(d1, 0.2)), q1]

    def root_point(self, t, theta, upper):
        return bezier(self.root_controls(theta, upper), t)

    def root_dt(self, t, theta, upper):
        c = self.root_controls(theta, upper)
        return bezier([mul(sub(c[i + 1], c[i]), 5) for i in range(5)], t)

    def profile(self):
        points = [(0, 0), (self.R - self.C, 0)]
        for k in range(1, 9):
            a = -math.pi / 2 + k * math.pi / 16
            points.append((self.R - self.C + self.C * math.cos(a), self.C + self.C * math.sin(a)))
        points.append((self.R, self.HEIGHT - self.T / 2))
        for k in range(1, 17):
            a = k * math.pi / 16
            points.append((self.R - self.T / 2 + self.T / 2 * math.cos(a), self.HEIGHT - self.T / 2 + self.T / 2 * math.sin(a)))
        points.append((self.R - self.T, self.B + self.C))
        for k in range(1, 9):
            a = k * math.pi / 16
            points.append((self.R - self.T - self.C + self.C * math.cos(a), self.B + self.C - self.C * math.sin(a)))
        points.append((0, self.B))
        return points

    def root_dtheta(self, t, theta, upper):
        """Exact theta partial of the quintic root, including endpoint jets."""
        ct, st = math.cos(theta), math.sin(theta)
        x = math.sqrt(self.R * self.R - self.A * self.A * ct * ct)
        speed = self.A - self.r
        q0 = (self.A * self.A * ct * st / x, -self.A * st, self.A * ct)
        d0 = (-self.A * speed * ct * st * (2 / x + self.A * self.A * ct * ct / x**3),
              speed * st, -speed * ct)
        dd0 = (speed * speed * self.R * self.R * ct * st *
               (2 / x**3 + 3 * self.A * self.A * ct * ct / x**5), 0, 0)
        q1 = (0, -self.r * st, self.r * ct)
        sign = 1 if upper else -1
        alpha_speed = self.L / self.H
        d1 = (alpha_speed * sign * self.r * ct, 0, 0)
        dd1 = (0, 0, -alpha_speed * alpha_speed * self.r * ct)
        controls = [q0, add(q0, mul(d0, .2)), add(add(q0, mul(d0, .4)), mul(dd0, .05)),
                    add(sub(q1, mul(d1, .4)), mul(dd1, .05)), sub(q1, mul(d1, .2)), q1]
        return bezier(controls, t)

    def root_normal(self, t, theta, upper):
        a, b = self.root_dtheta(t, theta, upper), self.root_dt(t, theta, upper)
        return unit((a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]))

    def profile_normals(self):
        """Outward radial/Z normal at each exact profile sample."""
        result = [(0, -1), (0, -1)]
        for k in range(1, 9):
            angle = -math.pi / 2 + k * math.pi / 16
            result.append((math.cos(angle), math.sin(angle)))
        result.append((1, 0))
        for k in range(1, 17):
            angle = k * math.pi / 16
            result.append((math.cos(angle), math.sin(angle)))
        result.append((-1, 0))
        for k in range(1, 9):
            angle = k * math.pi / 16
            result.append((-math.cos(angle), math.sin(angle)))
        result.append((0, 1))
        return result
