-- =====================================================================
-- SEED de demostración. Datos 100% FICTICIOS.
-- =====================================================================
-- Las dos comunidades comparten categorías y subtipos y difieren en el
-- PROVEEDOR y en la CITA del manual. Eso es lo que demuestra la demo: la
-- misma frase, distinta respuesta, porque el protocolo es de la comunidad.
--
-- Idempotente: borrar las comunidades arrastra en cascada inmuebles,
-- proveedores, protocolos, expedientes y presupuestos.
-- =====================================================================

delete from fincas_comunidades where nombre in ('Madrid 1', 'Madrid 2');

with c as (
  insert into fincas_comunidades (nombre, direccion) values
    ('Madrid 1', 'C/ Serrano 118, Madrid'),
    ('Madrid 2', 'Av. de Brasil 27, Madrid')
  returning id, nombre
),
m1 as (select id from c where nombre = 'Madrid 1'),
m2 as (select id from c where nombre = 'Madrid 2'),

inm as (
  insert into fincas_inmuebles (comunidad_id, puerta, propietario_nombre, propietario_tel)
  select (select id from m1), * from (values
    ('1A', 'Lucía Ferrer Blanco',   '600 100 101'),
    ('2B', 'Andrés Pardo Molina',   '600 100 102'),
    ('3C', 'Marta Iglesias Cano',   '600 100 103')
  ) v
  union all
  select (select id from m2), * from (values
    ('1A', 'Nuria Salgado Ríos',    '600 200 201'),
    ('2B', 'Iván Bermejo Cuesta',   '600 200 202'),
    ('3C', 'Pablo Redondo Vera',    '600 200 203')
  ) v
  returning 1
),

prov as (
  insert into fincas_proveedores (comunidad_id, nombre, tel, especialidad)
  select (select id from m1), * from (values
    ('Ascensores OTIS — contrato Madrid 1', '910 000 111', 'ascensores'),
    ('Fontanería Aqua Norte',               '910 000 222', 'fontanería'),
    ('Electro Serrano',                     '910 000 333', 'electricidad')
  ) v
  union all
  select (select id from m2), * from (values
    ('Ascensores DELTA — contrato Madrid 2', '910 000 444', 'ascensores'),
    ('Fontanería Bravo Sur',                 '910 000 555', 'fontanería'),
    ('Luz Delicias Instalaciones',           '910 000 666', 'electricidad')
  ) v
  returning 1
)

insert into fincas_protocolos
  (comunidad_id, categoria, subtipo, proveedor_nombre, proveedor_tel,
   urgencia_default, pasos, cita_fuente, palabras_clave)
select (select id from m1), * from (values
  ('ascensores', 'parado', 'Ascensores OTIS — contrato Madrid 1', '910 000 111', 'alta',
   '["Confirmar si hay personas atrapadas dentro de la cabina.","Avisar al mantenedor OTIS en el teléfono de guardia 24 h.","Colocar cartel de fuera de servicio en el portal.","Abrir expediente y notificar al presidente de la comunidad."]'::jsonb,
   'Manual de incidencias · Comunidad Madrid 1 · §3.1 Ascensores — avería sin atrapados',
   'ascensor elevador parado averiado no funciona no sube no baja bloqueado detenido cabina'),

  ('ascensores', 'atrapamiento', 'Ascensores OTIS — contrato Madrid 1', '910 000 111', 'critica',
   '["Llamar al 112 de inmediato.","Avisar a OTIS como rescate prioritario 24 h.","Mantener contacto por el interfono con las personas atrapadas.","Abrir expediente crítico y avisar al administrador por teléfono."]'::jsonb,
   'Manual de incidencias · Comunidad Madrid 1 · §3.2 Ascensores — rescate con personas atrapadas',
   'atrapado atrapada atrapados encerrado gente dentro rescate ascensor emergencia 112'),

  ('fontaneria', 'fuga_zonas_comunes', 'Fontanería Aqua Norte', '910 000 222', 'alta',
   '["Cerrar la llave general de la zona afectada.","Avisar a Fontanería Aqua Norte.","Fotografiar los daños para el parte del seguro.","Abrir expediente con la referencia del seguro de la comunidad."]'::jsonb,
   'Manual de incidencias · Comunidad Madrid 1 · §5.4 Fontanería — fugas en zonas comunes',
   'fuga agua escape gotera tuberia rota inundacion garaje portal humedad'),

  ('electricidad', 'apagon_zonas_comunes', 'Electro Serrano', '910 000 333', 'alta',
   '["Comprobar el cuadro general del portal antes de avisar.","Avisar a Electro Serrano.","Verificar que el alumbrado de emergencia está operativo.","Abrir expediente."]'::jsonb,
   'Manual de incidencias · Comunidad Madrid 1 · §7.1 Electricidad — falta de suministro en zonas comunes',
   'luz apagon sin luz oscuras electricidad cuadro diferencial portal garaje escalera')
) v
union all
select (select id from m2), * from (values
  ('ascensores', 'parado', 'Ascensores DELTA — contrato Madrid 2', '910 000 444', 'alta',
   '["Confirmar si hay personas atrapadas dentro de la cabina.","Avisar al mantenedor DELTA en el teléfono de guardia 24 h.","Colocar cartel de fuera de servicio en el portal.","Abrir expediente y notificar al presidente de la comunidad."]'::jsonb,
   'Manual de incidencias · Comunidad Madrid 2 · §4.2 Ascensores — avería sin atrapados',
   'ascensor elevador parado averiado no funciona no sube no baja bloqueado detenido cabina'),

  ('ascensores', 'atrapamiento', 'Ascensores DELTA — contrato Madrid 2', '910 000 444', 'critica',
   '["Llamar al 112 de inmediato.","Avisar a DELTA como rescate prioritario 24 h.","Mantener contacto por el interfono con las personas atrapadas.","Abrir expediente crítico y avisar al administrador por teléfono."]'::jsonb,
   'Manual de incidencias · Comunidad Madrid 2 · §4.3 Ascensores — rescate con personas atrapadas',
   'atrapado atrapada atrapados encerrado gente dentro rescate ascensor emergencia 112'),

  ('fontaneria', 'fuga_zonas_comunes', 'Fontanería Bravo Sur', '910 000 555', 'alta',
   '["Cerrar la llave general de la zona afectada.","Avisar a Fontanería Bravo Sur.","Fotografiar los daños para el parte del seguro.","Abrir expediente con la referencia del seguro de la comunidad."]'::jsonb,
   'Manual de incidencias · Comunidad Madrid 2 · §6.1 Fontanería — fugas en zonas comunes',
   'fuga agua escape gotera tuberia rota inundacion garaje portal humedad'),

  ('electricidad', 'apagon_zonas_comunes', 'Luz Delicias Instalaciones', '910 000 666', 'alta',
   '["Comprobar el cuadro general del portal antes de avisar.","Avisar a Luz Delicias Instalaciones.","Verificar que el alumbrado de emergencia está operativo.","Abrir expediente."]'::jsonb,
   'Manual de incidencias · Comunidad Madrid 2 · §8.3 Electricidad — falta de suministro en zonas comunes',
   'luz apagon sin luz oscuras electricidad cuadro diferencial portal garaje escalera')
) v;

-- ---------------------------------------------------------------------
-- Expediente de ejemplo + el presupuesto de 800 € de la cola de aprobación.
-- ---------------------------------------------------------------------
with e as (
  insert into fincas_expedientes
    (comunidad_id, inmueble_id, tipo, subtipo, urgencia, estado, descripcion,
     protocolo_id, protocolo_citado, proveedor_nombre, proveedor_tel, proveedor_avisado_at)
  select
    c.id, i.id, 'ascensores', 'parado', 'alta', 'en_curso',
    'El ascensor se para entre la 2ª y la 3ª planta. Sin personas atrapadas.',
    p.id, p.cita_fuente, p.proveedor_nombre, p.proveedor_tel, now() - interval '2 hours'
  from fincas_comunidades c
  join fincas_inmuebles  i on i.comunidad_id = c.id and i.puerta = '3C'
  join fincas_protocolos p on p.comunidad_id = c.id
                          and p.categoria = 'ascensores' and p.subtipo = 'parado'
  where c.nombre = 'Madrid 1'
  returning id, proveedor_nombre
)
insert into fincas_presupuestos (expediente_id, proveedor_nombre, importe, partidas, estado)
select e.id, e.proveedor_nombre, 800.00,
  '[{"concepto":"Sustitución de contactor de maniobra","importe":320.00},
    {"concepto":"Mano de obra técnico (3 h)","importe":285.00},
    {"concepto":"Desplazamiento y puesta en marcha","importe":195.00}]'::jsonb,
  'pendiente'
from e;

-- ---------------------------------------------------------------------
-- Tres expedientes más para que el kanban tenga cuerpo en la reunión.
-- ---------------------------------------------------------------------
insert into fincas_expedientes
  (comunidad_id, inmueble_id, tipo, subtipo, urgencia, estado, descripcion,
   protocolo_id, protocolo_citado, proveedor_nombre, proveedor_tel, proveedor_avisado_at)
select c.id, i.id, p.categoria, p.subtipo, v.urgencia, v.estado, v.descripcion,
       p.id, p.cita_fuente, p.proveedor_nombre, p.proveedor_tel, v.avisado
from (values
  ('Madrid 2', '1A', 'fontaneria',   'fuga_zonas_comunes',   'alta', 'nuevo',
   'Sale agua por el techo del garaje, junto a la plaza 12.', now() - interval '20 minutes'),
  ('Madrid 1', '2B', 'electricidad', 'apagon_zonas_comunes', 'alta', 'asignado',
   'Sin luz en la escalera desde el 2º hasta el 5º.',         now() - interval '5 hours'),
  ('Madrid 2', '3C', 'ascensores',   'parado',               'alta', 'cerrado',
   'El ascensor se quedó parado en la 4ª. Ya reparado.',      now() - interval '3 days')
) as v(comunidad, puerta, categoria, subtipo, urgencia, estado, descripcion, avisado)
join fincas_comunidades c on c.nombre = v.comunidad
join fincas_inmuebles   i on i.comunidad_id = c.id and i.puerta = v.puerta
join fincas_protocolos  p on p.comunidad_id = c.id
                         and p.categoria = v.categoria and p.subtipo = v.subtipo;
