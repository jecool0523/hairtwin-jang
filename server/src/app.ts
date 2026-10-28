import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { buildRouter } from './routes/index.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { requestContext } from './middleware/requestContext.js';
import { AppError } from './utils/http.js';
export function buildApp(): express.Express {
    const app = express();
    app.disable('x-powered-by');
    if (process.env.VERCEL) app.set('trust proxy', 1);
    app.use(requestContext);
    app.use(helmet({ crossOriginResourcePolicy: false }));
    app.use(cors({ origin: config.corsOrigin, credentials: false, exposedHeaders: ['X-Request-ID'] }));
    app.use(express.json({ limit: process.env.VERCEL ? '4mb' : '40mb' }));
    morgan.token('safe-path', req => req.url?.split('?')[0] ?? '/');
    app.use(morgan(':method :safe-path :status :response-time ms'));
    app.use(rateLimit({
        windowMs: 60000,
        max: 300,
        standardHeaders: true,
        legacyHeaders: false,
        handler: (_req, _res, next) => next(new AppError(429, 'RATE_LIMITED', '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.')),
    }));
    app.use('/api', buildRouter());
    app.use(notFoundHandler);
    app.use(errorHandler);
    return app;
}
