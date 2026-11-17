INSERT INTO servicos (id, nome, duracao_min, preco, descricao) VALUES
  (1, 'Corte feminino',         60,  90.00, 'Corte com lavagem e finalização'),
  (2, 'Escova',                 45,  60.00, 'Escova modeladora'),
  (3, 'Coloração',             120, 180.00, 'Coloração completa, sem mechas'),
  (4, 'Progressiva',           180, 280.00, 'Escova progressiva'),
  (5, 'Manicure',               45,  35.00, 'Cutilagem e esmaltação'),
  (6, 'Pedicure',               50,  40.00, 'Cutilagem e esmaltação dos pés'),
  (7, 'Design de sobrancelha',  30,  45.00, 'Design com pinça');
SELECT setval('servicos_id_seq', (SELECT max(id) FROM servicos));

INSERT INTO profissionais (id, nome) VALUES
  (1, 'Carla'),
  (2, 'Juliana'),
  (3, 'Bia');
SELECT setval('profissionais_id_seq', (SELECT max(id) FROM profissionais));

INSERT INTO profissional_servico (profissional_id, servico_id) VALUES
  (1, 1), (1, 2), (1, 3), (1, 4),  -- Carla: corte, escova, coloração, progressiva
  (2, 1), (2, 2), (2, 3), (2, 7),  -- Juliana: corte, escova, coloração, sobrancelha
  (3, 5), (3, 6), (3, 7);          -- Bia: manicure, pedicure, sobrancelha

-- Todas: terça a sexta 09-12 e 13-19; sábado 08-14.
INSERT INTO expediente (profissional_id, dia_semana, inicio, fim)
SELECT p.id, d.dia, h.inicio, h.fim
FROM profissionais p
CROSS JOIN generate_series(2, 5) AS d(dia)
CROSS JOIN (VALUES ('09:00'::time, '12:00'::time), ('13:00'::time, '19:00'::time)) AS h(inicio, fim)
UNION ALL
SELECT p.id, 6, '08:00', '14:00'
FROM profissionais p;