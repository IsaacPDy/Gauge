-- Batch 1 connectors: Vercel and Neon join the providers a connection may use.
alter table public.provider_connections drop constraint provider_connections_provider_check;
alter table public.provider_connections add constraint provider_connections_provider_check
  check (provider in ('supabase', 'cloudflare', 'firebase', 'aws', 'vercel', 'neon', 'demo'));
