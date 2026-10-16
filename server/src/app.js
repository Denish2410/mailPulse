import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';

import healthRoutes from './routes/health.routes.js';
import authRoutes from './routes/auth.routes.js';
import { notFound, errorHandler } from './middleware/errorHandler.js';

const app = express();

// 1. Security HTTP headers
// Sets HSTS, X-Content-Type-Options, Frameguard, and cross-origin resource policy for JSON APIs
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);

// 2. CORS configuration
// Parses comma-separated CLIENT_URL values or defaults to local Vite frontend
const allowedOrigins = process.env.CLIENT_URL
  ? process.env.CLIENT_URL.split(',').map((origin) => origin.trim())
  : ['http://localhost:5173'];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow non-browser requests (curl, server-to-server, mobile apps) with no origin header
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      // For unapproved origins, return false to omit Access-Control-Allow-Origin header safely
      return callback(null, false);
    },
    credentials: true,
  })
);

// 3. Request body parsing with appropriate size limits
// 1mb limit protects against payload exhaustion attacks; file uploads will use dedicated multipart streams
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// 4. Request logging (Morgan)
if (process.env.NODE_ENV !== 'test') {
  const isProduction = process.env.NODE_ENV === 'production';
  const logFormat = isProduction ? 'combined' : 'dev';

  app.use(
    morgan(logFormat, {
      skip: (req, res) => {
        // Skip logging successful health probes to avoid log spamming in development and production
        if (req.originalUrl?.startsWith('/api/v1/health') && res.statusCode < 400) {
          return true;
        }
        return false;
      },
    })
  );
}

// 5. API Rate limiting
const limiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX) || 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many requests from this IP address, please try again later.',
  },
});
app.use('/api', limiter);

// 6. Application routes
app.use('/api/v1/health', healthRoutes);
app.use('/api/v1/auth', authRoutes);

// 7. Not-found middleware (unmatched routes)
app.use(notFound);

// 8. Centralized error-handling middleware
app.use(errorHandler);

export default app;
