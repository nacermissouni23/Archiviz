import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GraphStore } from './store.js';

export type SystemKind = 'database' | 'api' | 'cloud' | 'queue' | 'email' | 'search';

const SYSTEM_SIGNATURES: Record<string, SystemKind> = {
  // databases
  pg: 'database', postgres: 'database', mysql: 'database', mysql2: 'database',
  mongodb: 'database', mongoose: 'database', sqlite3: 'database',
  'better-sqlite3': 'database', redis: 'database', ioredis: 'database',
  prisma: 'database', '@prisma/client': 'database', knex: 'database',
  sequelize: 'database', typeorm: 'database', 'drizzle-orm': 'database',
  // external APIs / SDKs
  openai: 'api', '@openai/agents': 'api', '@google/generative-ai': 'api',
  '@google-cloud/vertexai': 'api', anthropic: 'api', '@anthropic-ai/sdk': 'api',
  stripe: 'api', twilio: 'api', sendgrid: 'api', '@sendgrid/mail': 'api',
  mailgun: 'api', razorpay: 'api',
  // cloud
  'aws-sdk': 'cloud', '@aws-sdk/client-s3': 'cloud', '@aws-sdk/client-dynamodb': 'cloud',
  '@aws-sdk/client-sqs': 'cloud', '@aws-sdk/client-sns': 'cloud',
  '@google-cloud/storage': 'cloud', '@azure/storage-blob': 'cloud',
  // queues / brokers
  amqplib: 'queue', bullmq: 'queue', bull: 'queue', kafkajs: 'queue', nats: 'queue',
  // email
  nodemailer: 'email', resend: 'email',
  // search
  elasticsearch: 'search', '@elastic/elasticsearch': 'search', meilisearch: 'search',
  // ---- cross-ecosystem aliases (python / go / jvm / rust / ruby / php) ----
  psycopg2: 'database', 'psycopg2-binary': 'database', psycopg: 'database', pymongo: 'database', sqlalchemy: 'database',
  'mysql-connector-python': 'database', mysqlclient: 'database', motor: 'database',
  'gorm.io/gorm': 'database', 'github.com/lib/pq': 'database',
  'github.com/go-sql-driver/mysql': 'database', 'github.com/redis/go-redis': 'database',
  diesel: 'database', sqlx: 'database', sequel: 'database',
  boto3: 'cloud', 'google-cloud-storage': 'cloud', 'google.golang.org/api': 'cloud',
  celery: 'queue', 'confluent-kafka': 'queue', pika: 'queue',
  'github.com/segmentio/kafka-go': 'queue', 'php-amqplib/php-amqplib': 'queue',
  sidekiq: 'queue', resque: 'queue',
  // Java/JVM ecosystem
  'org.springframework.boot': 'api', 'org.springframework': 'api', 'org.springframework.web': 'api',
  'org.springframework.boot:spring-boot-starter-web': 'api', 'org.springframework.boot:spring-boot-starter-data-jpa': 'database',
  'org.postgresql:postgresql': 'database', 'com.h2database:h2': 'database', 'com.zaxxer:HikariCP': 'database',
  'org.mybatis:mybatis': 'database', 'org.hibernate:hibernate-core': 'database',
  'org.apache.kafka:kafka-clients': 'queue', 'org.springframework.kafka:spring-kafka': 'queue',
  'com.rabbitmq:amqp-client': 'queue', 'org.apache.activemq:activemq-client': 'queue',
  'org.elasticsearch.client:elasticsearch-rest-high-level-client': 'search',
  'co.elastic.clients:elasticsearch-java': 'search', 'org.elasticsearch:elasticsearch': 'search',
  'com.amazonaws:aws-java-sdk-s3': 'cloud', 'software.amazon.awssdk:s3': 'cloud',
  'com.google.cloud:google-cloud-storage': 'cloud', 'com.sendgrid:sendgrid-java': 'email',
  'javax.mail:javax.mail-api': 'email', 'org.apache.commons:commons-email': 'email',
  'com.twilio.sdk:twilio': 'api', 'com.stripe:stripe-java': 'api',
};

const LABEL_OVERRIDES: Record<string, string> = {
  pg: 'PostgreSQL', postgres: 'PostgreSQL', mysql2: 'MySQL', mysql: 'MySQL',
  mongodb: 'MongoDB', mongoose: 'MongoDB', sqlite3: 'SQLite', 'better-sqlite3': 'SQLite',
  ioredis: 'Redis', redis: 'Redis', '@prisma/client': 'Prisma', 'drizzle-orm': 'Drizzle ORM',
  openai: 'OpenAI', '@google/generative-ai': 'Google AI', '@google-cloud/vertexai': 'Vertex AI',
  '@anthropic-ai/sdk': 'Anthropic Claude', anthropic: 'Anthropic Claude',
  'aws-sdk': 'AWS', '@aws-sdk/client-s3': 'AWS S3', '@aws-sdk/client-dynamodb': 'DynamoDB',
  '@aws-sdk/client-sqs': 'AWS SQS', '@aws-sdk/client-sns': 'AWS SNS',
  '@google-cloud/storage': 'Google Cloud Storage', '@azure/storage-blob': 'Azure Blob Storage',
  bullmq: 'BullMQ', kafkajs: 'Kafka', amqplib: 'RabbitMQ', nats: 'NATS',
  '@elastic/elasticsearch': 'Elasticsearch', elasticsearch: 'Elasticsearch',
  '@sendgrid/mail': 'SendGrid',
  psycopg2: 'PostgreSQL', 'psycopg2-binary': 'PostgreSQL', psycopg: 'PostgreSQL',
  pymongo: 'MongoDB', sqlalchemy: 'SQLAlchemy', 'mysql-connector-python': 'MySQL',
  mysqlclient: 'MySQL', 'github.com/lib/pq': 'PostgreSQL',
  'github.com/redis/go-redis': 'Redis', 'gorm.io/gorm': 'GORM',
  'github.com/go-sql-driver/mysql': 'MySQL', boto3: 'AWS', celery: 'Celery',
  'confluent-kafka': 'Kafka', pika: 'RabbitMQ', 'google-cloud-storage': 'Google Cloud Storage',
  // Java/JVM
  'org.springframework.boot': 'Spring Boot', 'org.springframework': 'Spring',
  'org.springframework.boot:spring-boot-starter-web': 'Spring Web',
  'org.springframework.boot:spring-boot-starter-data-jpa': 'Spring Data JPA',
  'org.postgresql:postgresql': 'PostgreSQL', 'com.h2database:h2': 'H2 Database',
  'com.zaxxer:HikariCP': 'HikariCP', 'org.mybatis:mybatis': 'MyBatis',
  'org.hibernate:hibernate-core': 'Hibernate',
  'org.apache.kafka:kafka-clients': 'Kafka', 'org.springframework.kafka:spring-kafka': 'Spring Kafka',
  'com.rabbitmq:amqp-client': 'RabbitMQ',
  'co.elastic.clients:elasticsearch-java': 'Elasticsearch',
  'com.amazonaws:aws-java-sdk-s3': 'AWS S3', 'software.amazon.awssdk:s3': 'AWS S3',
  'com.google.cloud:google-cloud-storage': 'Google Cloud Storage',
  'com.stripe:stripe-java': 'Stripe', 'com.twilio.sdk:twilio': 'Twilio',
};

function matchSystemKind(name: string): { kind: SystemKind; key: string } | undefined {
  const exact = SYSTEM_SIGNATURES[name];
  if (exact) return { kind: exact, key: name };
  // go-style versioned paths: github.com/redis/go-redis/v9 → github.com/redis/go-redis
  for (const [key, kind] of Object.entries(SYSTEM_SIGNATURES)) {
    if (key.includes('/') && name.startsWith(key + '/')) return { kind, key };
  }
  return undefined;
}

const SERVER_PACKAGES = new Set([
  'express', 'fastify', 'koa', '@hapi/hapi', 'hono', 'next', 'restify',
]);

const CRON_PACKAGES = new Set(['node-cron', 'cron', '@nestjs/schedule', 'bree']);

const KIND_LABEL: Record<SystemKind, string> = {
  database: 'Database',
  api: 'External API',
  cloud: 'Cloud service',
  queue: 'Message queue',
  email: 'Email service',
  search: 'Search engine',
};

const KIND_REL: Record<SystemKind, string> = {
  database: 'queries',
  queue: 'publishes',
  api: 'calls API',
  cloud: 'stores',
  email: 'sends',
  search: 'searches',
};

const ENV_HINTS: Record<SystemKind, RegExp[]> = {
  database: [/DATABASE/, /^DB_/, /POSTGRES/, /MYSQL/, /MONGO/],
  api: [/API_KEY/, /API_SECRET/, /_TOKEN/, /OPENAI/, /STRIPE/, /ANTHROPIC/, /GEMINI/, /TWILIO/],
  cloud: [/^AWS_|_AWS_|S3_|GCS_|AZURE_/],
  queue: [/QUEUE/, /KAFKA/, /RABBIT/, /AMQP/, /BROKER/],
  email: [/MAIL/, /SMTP/, /EMAIL/],
  search: [/ELASTIC/, /SEARCH_/],
};

const SERVER_REL = 'HTTP';

export interface ContextSystem {
  name: string;
  kind: SystemKind;
  label: string;
  relation: string;
  confidence: 'high' | 'medium';
  importFiles: string[];
  envVars: string[];
  usedBy: string[];
  /** set when the system is only a declared dependency, never imported */
  declaredIn?: string;
}

export interface ContextActor {
  id: string;
  label: string;
  relation: string;
  evidence: { bin?: string; argv?: boolean; pkg?: string; routes?: string[] };
}

export interface ContextLibrary {
  name: string;
  count: number;
  role?: string;
  /** set when the library is only a declared dependency, never imported */
  declaredIn?: string;
}

export interface ContextAnnotations {
  app?: { label?: string; description?: string };
  systems?: Record<string, string>;
  actors?: Record<string, string>;
  libraries?: Record<string, string>;
}

export interface ContextData {
  name: string;
  stats: { files: number; symbols: number; calls: number; libraries: number };
  systems: ContextSystem[];
  actors: ContextActor[];
  libraries: ContextLibrary[];
  ai: { pending: boolean; applied: boolean; error?: string };
  annotations?: ContextAnnotations;
}

function prettyPkg(name: string): string {
  if (name.includes('/')) return name.split('/').pop() ?? name;
  const base = name.startsWith('@') ? name.split('/')[1] : name;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function correlateEnv(kind: SystemKind, pkgName: string, envVars: Map<string, Set<string>>): string[] {
  const hints = ENV_HINTS[kind];
  const pkgToken = (pkgName.startsWith('@') ? pkgName.split('/')[1] : pkgName).toUpperCase();
  const hits: string[] = [];
  for (const [name] of envVars) {
    if (name.length < 4 || name.length > 60) continue;
    const matched =
      hints.some((re) => re.test(name)) || name.toUpperCase().includes(pkgToken);
    if (matched) hits.push(name);
    if (hits.length >= 6) break;
  }
  return hits;
}

function detectActors(store: GraphStore, rootPath: string): ContextActor[] {
  const actors: ContextActor[] = [];

  // CLI actor
  let cliEvidence: ContextActor['evidence'] | undefined;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootPath, 'package.json'), 'utf8'));
    if (pkg.bin) {
      cliEvidence = { bin: typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin)[0] };
    }
  } catch {
    /* no package.json */
  }
  if (!cliEvidence) {
    try {
      const pyproject = fs.readFileSync(path.join(rootPath, 'pyproject.toml'), 'utf8');
      const scripts = pyproject.match(/\[project\.scripts\]([\s\S]*?)(?:\n\[|$)/);
      if (scripts) {
        const m = scripts[1].match(/^([\w.-]+)\s*=/m);
        if (m) cliEvidence = { bin: `pyproject.toml: ${m[1]}` };
      }
    } catch {
      /* no pyproject */
    }
  }
  if (!cliEvidence) {
    for (const node of store.nodes.values()) {
      if (node.type === 'file' && (node.id === 'cli.py' || node.id === '__main__.py')) {
        cliEvidence = { bin: node.id };
        break;
      }
    }
  }
  if (!cliEvidence) {
    for (const node of store.nodes.values()) {
      if (node.type === 'file' && node.id.startsWith('bin/')) {
        cliEvidence = { bin: 'bin/' };
        break;
      }
    }
  }
  if (!cliEvidence && store.hasArgv) {
    cliEvidence = { argv: true };
  }
  if (cliEvidence) {
    actors.push({ id: 'cli', label: 'CLI', relation: 'invokes', evidence: cliEvidence });
  }

  // HTTP client actor: server framework imported AND at least one route literal
  const serverPkg = [...SERVER_PACKAGES].find((p) => store.externals.has(p));
  const routeSamples = store.routes
    .filter((r) => !/\/webhook/i.test(r.path))
    .slice(0, 8)
    .map((r) => `${r.method} ${r.path}`);
  if (serverPkg && routeSamples.length > 0) {
    actors.push({
      id: 'http',
      label: 'HTTP client',
      relation: SERVER_REL,
      evidence: { pkg: serverPkg, routes: routeSamples },
    });
  }

  // Webhook provider actor
  const webhookRoutes = store.routes
    .filter((r) => /\/webhook/i.test(r.path))
    .slice(0, 5)
    .map((r) => `${r.method} ${r.path}`);
  if (webhookRoutes.length > 0) {
    actors.push({
      id: 'webhook',
      label: 'Webhook provider',
      relation: 'notifies',
      evidence: { routes: webhookRoutes },
    });
  }

  // Scheduler actor
  const cronPkg = [...CRON_PACKAGES].find((p) => store.externals.has(p));
  if (cronPkg) {
    actors.push({ id: 'cron', label: 'Scheduler', relation: 'triggers', evidence: { pkg: cronPkg } });
  }

  return actors;
}

export function buildContext(store: GraphStore, rootName: string, rootPath: string): ContextData {
  const systems: ContextSystem[] = [];
  const libraries: ContextLibrary[] = [];

  const externals = [...store.externals.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  for (const { name, count } of externals) {
    const match = matchSystemKind(name);
    const users = [...(store.externalUsers.get(name) ?? [])].sort();
    if (match) {
      const importFiles = users.slice(0, 3);
      const envVars = correlateEnv(match.kind, name, store.envVars);
      systems.push({
        name,
        kind: match.kind,
        label: LABEL_OVERRIDES[name] ?? LABEL_OVERRIDES[match.key] ?? prettyPkg(name),
        relation: KIND_REL[match.kind],
        confidence: 'high',
        importFiles,
        envVars,
        usedBy: users.slice(0, 20),
      });
    } else {
      libraries.push({ name, count });
    }
  }

  // manifest-only dependencies (declared but never imported) → medium confidence
  for (const [name, sources] of store.manifestDeps) {
    if (store.externals.has(name)) continue; // imported → already handled above as high
    const match = matchSystemKind(name);
    if (match) {
      const declaredIn = sources.split(', ')[0];
      systems.push({
        name,
        kind: match.kind,
        label: LABEL_OVERRIDES[name] ?? LABEL_OVERRIDES[match.key] ?? prettyPkg(name),
        relation: KIND_REL[match.kind],
        confidence: 'medium',
        importFiles: [],
        envVars: correlateEnv(match.kind, name, store.envVars),
        usedBy: [],
        declaredIn,
      });
    } else {
      libraries.push({ name, count: 0, declaredIn: sources.split(', ')[0] });
    }
  }

  // env-only systems: strong env tokens with no matching import → medium confidence
  const ENV_ONLY: [RegExp, string, SystemKind][] = [
    [/^MONGO/, 'mongodb', 'database'],
    [/^REDIS/, 'redis', 'database'],
    [/^POSTGRES/, 'pg', 'database'],
    [/^PGDATABASE|^PGHOST|^PGUSER/, 'pg', 'database'],
    [/^MYSQL/, 'mysql2', 'database'],
    [/^S3_|^AWS_S3/, '@aws-sdk/client-s3', 'cloud'],
    [/^KAFKA/, 'kafkajs', 'queue'],
    [/^RABBIT|^AMQP/, 'amqplib', 'queue'],
    [/^SMTP|^MAIL_HOST/, 'nodemailer', 'email'],
    [/^STRIPE/, 'stripe', 'api'],
    [/^OPENAI/, 'openai', 'api'],
    [/^ELASTIC/, '@elastic/elasticsearch', 'search'],
  ];
  for (const [re, pkg, kind] of ENV_ONLY) {
    if (systems.some((s) => s.name === pkg)) continue;
    const vars = [...store.envVars.keys()].filter((v) => re.test(v)).slice(0, 4);
    if (vars.length === 0) continue;
    systems.push({
      name: pkg,
      kind,
      label: LABEL_OVERRIDES[pkg] ?? prettyPkg(pkg),
      relation: KIND_REL[kind],
      confidence: 'medium',
      importFiles: [],
      envVars: vars,
      usedBy: [],
    });
  }

  const s = store.stats();
  return {
    name: rootName,
    stats: { files: s.files, symbols: s.syms, calls: s.calls, libraries: libraries.length },
    systems,
    actors: detectActors(store, rootPath),
    libraries,
    ai: { pending: false, applied: false },
  };
}

// ---------- AI annotation pass ----------

function extractionText(text: string): string {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  return t;
}

const GENERIC_ROLES =
  /^(ui |web |build |test |dev )?(library|framework|plugin|package|tool|module|util(ity)?|wrapper|sdk|binding)s?$/i;

export async function annotateContext(
  data: ContextData,
  apiKey: string,
  model: string
): Promise<ContextAnnotations | null> {
  const prompt = [
    'You are describing what a code repository IS, what outside systems it talks to, and who interacts with it.',
    'Return ONLY strict JSON, no prose, no markdown fences, shaped exactly like:',
    '{"app":{"label":"short human name","description":"one sentence: what this application is"},' +
      '"systems":[{"name":"pg","label":"PostgreSQL database"}],' +
      '"actors":[{"id":"http","label":"Browser clients"}],' +
      '"libraries":[{"name":"react","role":"UI library"}]}',
    'Rules:',
    '- The app identity comes ONLY from the folder names and evidence given. Do not invent features.',
    '- system/actor labels must describe WHAT the thing is (e.g. "PostgreSQL database", "Browser clients"). Never repeat the raw id/name as the label.',
    '- Use ONLY the system names, actor ids and library names given. Never add entries.',
    '- libraries roles must be SPECIFIC: "Mermaid diagram renderer", "React UI framework", never bare "library" or "UI library".',
    '- app.description max 20 words.',
    '',
    JSON.stringify({
      repoName: data.name,
      systems: data.systems.map((s) => ({ name: s.name, kind: s.kind, evidence: [...s.importFiles, ...s.envVars] })),
      actors: data.actors.map((a) => ({ id: a.id, evidence: a.evidence })),
      libraries: data.libraries.slice(0, 20).map((l) => l.name),
    }),
  ].join('\n');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2 },
        }),
        signal: ctrl.signal,
      }
    );
    if (!res.ok) throw new Error(`gemini ${res.status}`);
    const json: any = await res.json();
    const text: string | undefined = json?.candidates?.[0]?.content?.parts
      ?.map((p: any) => p?.text ?? '')
      .join('');
    if (!text) throw new Error('empty response');

    const parsed = JSON.parse(extractionText(text));
    const annotations: ContextAnnotations = {};

    if (parsed?.app && typeof parsed.app === 'object') {
      annotations.app = {
        label: typeof parsed.app.label === 'string' ? parsed.app.label.slice(0, 60) : undefined,
        description:
          typeof parsed.app.description === 'string' ? parsed.app.description.slice(0, 160) : undefined,
      };
    }

    const systemNames = new Set(data.systems.map((s) => s.name));
    annotations.systems = {};
    for (const s of parsed?.systems ?? []) {
      if (
        typeof s?.name === 'string' &&
        typeof s?.label === 'string' &&
        systemNames.has(s.name) &&
        s.label.trim().toLowerCase() !== s.name.toLowerCase()
      ) {
        annotations.systems[s.name] = s.label.slice(0, 60);
      }
    }

    const actorIds = new Set(data.actors.map((a) => a.id));
    annotations.actors = {};
    for (const a of parsed?.actors ?? []) {
      if (
        typeof a?.id === 'string' &&
        typeof a?.label === 'string' &&
        actorIds.has(a.id) &&
        a.label.trim().toLowerCase() !== a.id.toLowerCase()
      ) {
        annotations.actors[a.id] = a.label.slice(0, 60);
      }
    }

    const libNames = new Set(data.libraries.map((l) => l.name));
    annotations.libraries = {};
    for (const l of parsed?.libraries ?? []) {
      if (
        typeof l?.name === 'string' &&
        typeof l?.role === 'string' &&
        libNames.has(l.name) &&
        l.role.trim().toLowerCase() !== l.name.toLowerCase() &&
        !GENERIC_ROLES.test(l.role.trim())
      ) {
        annotations.libraries[l.name] = l.role.slice(0, 40);
      }
    }

    return annotations;
  } finally {
    clearTimeout(timer);
  }
}
