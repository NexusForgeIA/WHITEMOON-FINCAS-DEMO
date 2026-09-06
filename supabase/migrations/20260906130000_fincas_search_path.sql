-- =====================================================================
-- Fija el search_path de las funciones de la demo de fincas
-- =====================================================================
-- Corrige el WARN `function_search_path_mutable` del linter de Supabase.
--
-- POR QUÉ IMPORTA AQUÍ MÁS QUE DE COSTUMBRE
-- Sin un search_path fijo, los nombres que hay dentro del cuerpo de la
-- función se resuelven con el search_path de QUIEN LLAMA. Basta con que un
-- rol tenga un esquema propio por delante de `public` para que
-- `fincas_protocolos` —o `plainto_tsquery`, o la configuración de texto
-- 'spanish'— apunten a otra cosa. Y toda la promesa de esta demo es que
-- `where comunidad_id = p_comunidad` se evalúa contra la tabla de
-- protocolos de verdad: tener el filtro cableado no vale nada si la tabla
-- puede ser suplantada.
--
-- pg_catalog para los builtins, public para las tablas de la demo, y se
-- acabó la ambigüedad.
--
-- NOTA: en una base creada desde cero esto ya viene puesto en el CREATE de
-- 20260906120000_fincas_demo_schema.sql. Esta migración existe para las
-- bases que se crearon antes; aplicarla dos veces no hace daño, fija el
-- mismo valor.

alter function public.fincas_buscar_protocolo(uuid, text)
  set search_path = pg_catalog, public;

alter function public.fincas_auditoria_append_only()
  set search_path = pg_catalog, public;
