-- =====================================================================
-- Whitemoon Fincas · SEED del catálogo estándar de una comunidad
-- ---------------------------------------------------------------------
-- Carga inicial reutilizable: proveedores + protocolos de las averías
-- típicas de una comunidad de vecinos. Se ejecuta UNA VEZ por comunidad.
--
-- CÓMO USARLO:
--   1. Da de alta la comunidad primero (nombre + dirección).
--   2. Pon su NOMBRE EXACTO abajo, en v_nombre_comunidad.
--   3. EDITA los proveedores con los datos REALES del cliente
--      (nombre, teléfono, email, persona de contacto). El resto se
--      autocompleta: el proveedor_nombre de cada protocolo se enlaza
--      por especialidad, así que si cambias el nombre de un proveedor,
--      cambia también el proveedor_nombre del/los protocolo(s) que lo usan.
--   4. Ejecútalo. Revisa la autonomía (arranca cerrada, 0 €).
--
-- REGLAS: la IA solo aplica lo que esté cargado aquí; lo que no esté,
-- lo escala a una persona. Ningún dato bancario ni de presidente va aquí
-- (eso vive en fincas_privado, fuera del alcance de la IA).
-- =====================================================================

do $$
declare
  v_cid uuid;
  v_nombre_comunidad text := 'NOMBRE EXACTO DE LA COMUNIDAD';   -- <<< EDITAR
begin
  select id into v_cid
  from public.fincas_comunidades
  where nombre = v_nombre_comunidad
  limit 1;

  if v_cid is null then
    raise exception 'No encuentro la comunidad "%". Da de alta la comunidad primero o corrige el nombre.', v_nombre_comunidad;
  end if;

  -- ------------------------------------------------------------------
  -- 1 · PROVEEDORES ESTÁNDAR  (EDITA tel / email / contacto con los reales)
  --     Si cambias el "nombre", cámbialo también en los protocolos de abajo.
  -- ------------------------------------------------------------------
  insert into public.fincas_proveedores
    (comunidad_id, nombre, tel, especialidad, email, zona, contacto_nombre, notas, activo)
  values
    (v_cid, 'Ascensores — EDITAR',            '', 'Ascensores',                      '', '', '', 'seed', true),
    (v_cid, 'Fontanería — EDITAR',            '', 'Fontanería',                      '', '', '', 'seed', true),
    (v_cid, 'Puertas de garaje — EDITAR',     '', 'Puertas de garaje y cerrajería',  '', '', '', 'seed', true),
    (v_cid, 'Electricidad — EDITAR',          '', 'Electricidad',                    '', '', '', 'seed', true),
    (v_cid, 'Calefacción/ACS — EDITAR',       '', 'Calefacción y ACS',               '', '', '', 'seed', true),
    (v_cid, 'Reformas/Cubiertas — EDITAR',    '', 'Albañilería, humedades y tejado', '', '', '', 'seed', true),
    (v_cid, 'Control de plagas — EDITAR',     '', 'Control de plagas',               '', '', '', 'seed', true),
    (v_cid, 'Limpieza — EDITAR',              '', 'Limpieza de zonas comunes',       '', '', '', 'seed', true),
    (v_cid, 'Jardinería — EDITAR',            '', 'Jardinería',                      '', '', '', 'seed', true),
    (v_cid, 'Antena/Telecom — EDITAR',        '', 'Antena y telecomunicaciones',     '', '', '', 'seed', true);

  -- Enlaza todos los proveedores de esta comunidad con la comunidad.
  insert into public.fincas_proveedor_comunidad (proveedor_id, comunidad_id)
  select p.id, v_cid
  from public.fincas_proveedores p
  where p.comunidad_id = v_cid
  on conflict (proveedor_id, comunidad_id) do nothing;

  -- ------------------------------------------------------------------
  -- 2 · PROTOCOLOS ESTÁNDAR
  --     proveedor_nombre debe COINCIDIR con el nombre del proveedor de arriba.
  -- ------------------------------------------------------------------
  insert into public.fincas_protocolos
    (comunidad_id, categoria, subtipo, proveedor_nombre, proveedor_tel, urgencia_default, pasos, cita_fuente, palabras_clave)
  values
  (v_cid,'Ascensor','Atrapamiento','Ascensores — EDITAR','','critica',
   '["Confirmar si hay personas dentro y tranquilizarlas","Llamar de inmediato al servicio de guardia del mantenedor","Informar a los afectados del tiempo estimado de llegada","Registrar el parte con la hora"]'::jsonb,
   'Contrato de mantenimiento del ascensor — protocolo de atrapamiento',
   'ascensor atrapado atrapamiento encerrado encerrada parada bloqueado gente dentro personas dentro'),
  (v_cid,'Ascensor','Averia sin personas','Ascensores — EDITAR','','media',
   '["Comprobar que no hay nadie dentro","Dar aviso al mantenedor para revision","Senalizar el ascensor fuera de servicio","Informar del plazo estimado"]'::jsonb,
   'Contrato de mantenimiento del ascensor — averia',
   'ascensor averia averiado parado no funciona ruido puertas no abre no sube'),
  (v_cid,'Fontanería','Fuga de agua','Fontanería — EDITAR','','alta',
   '["Cerrar la llave de paso general si el agua no para","Avisar al fontanero de guardia","Comprobar si afecta a otras viviendas o zonas comunes","Registrar el parte con la hora y la ubicacion"]'::jsonb,
   'Contrato de mantenimiento de fontanería — fuga de agua',
   'fuga agua goteo goteando escape tuberia cano rotura inundacion se sale agua mancha techo agua'),
  (v_cid,'Fontanería','Atasco','Fontanería — EDITAR','','media',
   '["Localizar el punto del atasco (bajante, arqueta, desague)","Avisar al fontanero","Evitar el uso del desague afectado hasta la visita"]'::jsonb,
   'Contrato de mantenimiento de fontanería — atascos',
   'atasco atascado atascada desague bajante arqueta huele mal alcantarilla no baja el agua'),
  (v_cid,'Puerta de garaje','No abre / motor','Puertas de garaje — EDITAR','','media',
   '["Comprobar si es el mando o la propia puerta","Avisar al servicio de puertas de garaje","Si queda abierta, avisar del riesgo de seguridad a los vecinos"]'::jsonb,
   'Contrato de mantenimiento de la puerta de garaje',
   'garaje puerta no abre no cierra motor mando averiada atascada parking puerta del parking'),
  (v_cid,'Electricidad','Zonas comunes sin luz','Electricidad — EDITAR','','alta',
   '["Comprobar el cuadro general y los diferenciales","Avisar al electricista de guardia","Priorizar portal, escaleras y garaje por seguridad"]'::jsonb,
   'Contrato de mantenimiento eléctrico — zonas comunes',
   'luz electricidad sin luz apagon cuadro diferencial saltado portal escalera rellano zonas comunes fundido bombilla garaje a oscuras'),
  (v_cid,'Portal / Acceso','Cerradura o portero','Puertas de garaje — EDITAR','','media',
   '["Comprobar si es la cerradura, la llave o el portero automatico","Avisar al servicio de cerrajeria","Si el portal no cierra, avisar del riesgo de seguridad"]'::jsonb,
   'Contrato de cerrajería y control de accesos',
   'portal cerradura llave portero automatico telefonillo no abre puerta de la calle acceso no cierra el portal'),
  (v_cid,'Gas','Olor o fuga de gas','Emergencias 112 / compañía de gas','112','critica',
   '["No encender ni apagar luces ni aparatos electricos","Cerrar la llave del gas si es accesible con seguridad","Ventilar abriendo ventanas","Salir del inmueble y llamar de inmediato a Emergencias 112 o a la compania de gas","Avisar a la administracion una vez a salvo"]'::jsonb,
   'Protocolo de seguridad — olor o fuga de gas',
   'gas olor a gas huele a gas fuga de gas escape de gas bombona butano caldera de gas'),
  (v_cid,'Calefacción','Calefacción o agua caliente central','Calefacción/ACS — EDITAR','','media',
   '["Comprobar si afecta a todo el edificio o solo a una vivienda","Avisar al servicio de calderas","Informar a los vecinos del plazo estimado"]'::jsonb,
   'Contrato de mantenimiento de calefacción central',
   'calefaccion no hay calefaccion sin agua caliente caldera radiadores frios acs no calienta no sale agua caliente'),
  (v_cid,'Humedades y tejado','Gotera o filtración','Reformas/Cubiertas — EDITAR','','media',
   '["Localizar de donde viene la filtracion (cubierta, fachada, terraza)","Avisar al servicio de reformas/cubiertas","Proteger la zona afectada mientras llega la visita"]'::jsonb,
   'Contrato de mantenimiento de cubierta y fachada',
   'gotera goteras filtracion filtraciones humedad humedades tejado cubierta fachada terraza pared mancha en el techo entra agua de lluvia'),
  (v_cid,'Plagas','Desinsectación o desratización','Control de plagas — EDITAR','','media',
   '["Identificar la plaga y la zona afectada","Avisar a la empresa de control de plagas","Recomendar no manipular cebos ni productos"]'::jsonb,
   'Contrato de control de plagas',
   'plaga plagas cucaracha cucarachas rata ratas raton ratones insectos avispas nido desinsectacion desratizacion bichos'),
  (v_cid,'Limpieza','Incidencia de limpieza de zonas comunes','Limpieza — EDITAR','','baja',
   '["Anotar la zona y el tipo de incidencia","Trasladar el aviso al servicio de limpieza","Confirmar cuando quedara resuelto"]'::jsonb,
   'Contrato de limpieza de zonas comunes',
   'limpieza sucio suciedad basura contenedores portal escaleras ascensor sucio no han limpiado cristales'),
  (v_cid,'Jardinería','Incidencia de jardinería','Jardinería — EDITAR','','baja',
   '["Anotar la zona ajardinada afectada","Avisar al servicio de jardineria","Confirmar la proxima visita programada"]'::jsonb,
   'Contrato de mantenimiento de jardines',
   'jardin jardineria cesped setos poda riego aspersores arboles ramas hojas maleza cortar cesped'),
  (v_cid,'Antena / TV','Antena o telecomunicaciones','Antena/Telecom — EDITAR','','baja',
   '["Comprobar si afecta a todo el edificio o solo a una vivienda","Avisar al servicio de antena/telecomunicaciones","Informar del plazo estimado"]'::jsonb,
   'Contrato de mantenimiento de antena colectiva',
   'antena tv television no se ven los canales sin senal parabolica telecomunicaciones no funciona la tele'),
  (v_cid,'Convivencia','Ruidos y molestias','Administración de la comunidad','','baja',
   '["Recoger el caso con el maximo detalle (dia, hora, vecino, tipo de molestia)","Trasladar a la administracion para mediar o aplicar los estatutos","Informar al vecino de que lo gestiona una persona del equipo"]'::jsonb,
   'Estatutos de la comunidad — normas de convivencia',
   'ruido ruidos molestias vecino musica alta fiestas obras fuera de hora animales convivencia');

  -- ------------------------------------------------------------------
  -- 3 · AUTONOMÍA — arranca CERRADA (0 €, nada automático que toque dinero)
  -- ------------------------------------------------------------------
  insert into public.fincas_config_autonomia
    (comunidad_id, umbral_auto_eur, tramites_confianza, notas, actualizado_por)
  values
    (v_cid, 0, '[]'::jsonb, 'Seed — arranca cerrada', 'seed');

  raise notice 'Catálogo estándar cargado para % (%).', v_nombre_comunidad, v_cid;
end $$;
