/*
 * GIFI codes (CRA's General Index of Financial Information, guide RC4088): the 4-digit codes a
 * corporation's balance sheet (Schedule 100) and income statement (Schedule 125) are filed with.
 *
 * Works in the browser (window.TallyGIFI) and in Node (require), so the server can give new charts of
 * accounts their codes and the tests can check them.
 *
 * The list of codes and descriptions is for picking and showing a code; any 4-digit code in the right
 * range for the account type is accepted, since CRA adds codes from time to time.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TallyGIFI = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // code|English|French, one per line.
  const DATA = `1000|Cash and deposits|Encaisse et dépôts
1001|Cash|Encaisse
1002|Deposits in Canadian banks and institutions – Canadian currency|Dépôts dans des banques et des institutions canadiennes – monnaie canadienne
1003|Deposits in Canadian banks and institutions – foreign currency|Dépôts dans des banques et des institutions canadiennes – devises étrangères
1004|Deposits in foreign banks – Canadian currency|Dépôts dans des banques étrangères – monnaie canadienne
1005|Deposits in foreign banks – foreign currency|Dépôts dans des banques étrangères – devises étrangères
1006|Credit union central deposits|Caisse de crédit – dépôt central
1007|Other cash like instruments – gold bullion, silver bullion|Autres éléments de l'actif assimilables à de l'encaisse
1060|Accounts receivable|Comptes clients
1061|Allowance for doubtful accounts receivable|Provision pour créances douteuses
1062|Trade accounts receivable|Comptes clients commerciaux
1063|Allowance for doubtful trade accounts receivable|Provision pour mauvaises créances – comptes clients commerciaux
1064|Trade accounts receivable related parties|Comptes clients de personnes apparentées
1065|Allowance for doubtful trade accounts receivable related parties|Provision pour mauvaises créances – personnes apparentées
1066|Taxes receivable|Impôts à recevoir
1067|Interest receivable|Intérêts à recevoir
1068|Holdbacks receivable|Retenues de garantie à recevoir
1069|Leases receivable|Créances au titre de baux
1070|Allowance for doubtful leases receivable|Provision pour éléments douteux contenus dans certaines créances au titre de baux
1071|Accounts receivable employees|Comptes à recevoir d'employés
1072|Allowance for doubtful accounts receivable employees|Provision pour mauvaises créances – employés
1073|Accounts receivable from members of NPO|Montants à recevoir de membres d'OSBL
1120|Inventories|Stocks
1121|Inventory of goods for sale/finished goods|Stock de marchandises à vendre
1122|Inventory of parts and supplies|Pièces et fournitures en stock
1123|Inventory properties|Biens immobiliers figurant dans un inventaire
1124|Inventory of aggregates|Stocks d'agrégats
1125|Work in progress|Travaux en cours
1126|Raw materials|Matières premières
1127|Inventory of securities|Titres figurant dans un inventaire
1180|Short term investments|Placements à court terme
1181|Canadian term deposits|Dépôts à terme canadiens
1182|Canadian shares|Actions de sociétés canadiennes
1183|Canadian bonds|Obligations canadiennes
1184|Canadian treasury bills|Bonds du Trésor canadien
1185|Securities purchased under resale agreement|Titres acquis avec entente de rachat
1186|Other short term Canadian investments|Autres placements canadiens à court terme
1187|Short term foreign investments|Placements étrangers à court terme
1240|Loans and notes receivable|Prêts et effets à recevoir
1241|Demand loans receivable|Prêts remboursables sur demande
1242|Other loans receivable|Autres prêts non remboursés
1243|Notes receivable|Effets à recevoir
1244|Mortgages receivable|Hypothèques à recevoir
1300|Due from shareholder(s)/director(s)|Sommes exigibles d'actionnaire(s)/d'administrateur(s)
1301|Due from individual shareholder(s)|Sommes exigibles d'actionnaire(s) (particuliers)
1302|Due from corporate shareholder(s)|Sommes exigibles d'actionnaire(s) (sociétés)
1303|Due from director(s)|Sommes exigibles d'administrateur(s)
1360|Investment in joint venture(s)/partnership(s)|Placements dans une(des) coentreprise(s)/ société(s) de personnes
1380|Due from joint venture(s)/partnership(s)|Sommes exigibles de coentreprise(s)/société(s) de personnes
1400|Due from/investment in related parties|Sommes exigibles des personnes apparentées/placements dans des personnes apparentées
1401|Demand notes from related parties|Billets à demande de personnes apparentées
1402|Interest receivable from related parties|Intérêts à recevoir de personnes apparentées
1403|Loans/Advances due from related parties|Prêts/avances à des personnes apparentées
1460|Customer's liability under acceptances|Dettes des clients pour acceptation
1480|Other current assets|Autres éléments d'actif à court terme
1481|Deferred income taxes|Impôts sur le revenu reportés
1482|Accrued investment income|Revenus de placements accumulés
1483|Taxes recoverable/refundable|Impôts recouvrables/remboursables
1484|Prepaid expenses|Dépenses payées d'avance
1485|Drilling advances|Avances de forage
1486|Security deposits|Cautionnement/dépôts sur soumissions
1599|Total current assets|Total de l'actif à court terme
1600|Land|Terrains
1601|Land improvement|Frais d'amélioration des terrains
1602|Accumulated amortization of land and land improvement|Amortissement cumulé de l'amélioration des terrains
1620|Depletable assets|Biens épuisables
1621|Accumulated amortization of depletable assets|Amortissement cumulé des biens épuisables
1622|Petroleum and natural gas properties|Biens en ressources pétrolifères et en gaz naturel
1623|Accumulated amortization of petroleum and natural gas properties|Amortissement cumulé des biens en ressources
1624|Mining properties|Biens miniers
1625|Accumulated amortization of mining properties|Amortissement cumulé des biens miniers
1626|Deferred exporation and development charges|Frais d'exploration et d'exploitation reportés
1627|Accumulated amortization of petroleum and deferred exporation and development charges|Amortissement cumulé des frais d'exploration et d'exploitation reportés
1628|Quarries|Carrières
1629|Accumulated amortization of quarries|Amortissement cumulé des carrières
1630|Gravel pits|Carrières de gravier
1631|Accumulated amortization of gravel pits|Amortissement cumulé des carrières de gravier
1632|Timber limits|Concessions forestières
1633|Accumulated amortization of timber limits|Amortissement cumulé des concessions forestières
1680|Buildings|Bâtiments
1681|Accumulated amortization of buildings|Amortissement cumulé des bâtiments
1682|Manufacturing and processing plant|Installations de fabrication et de traitement
1683|Accumulated amortization of manufacturing and processing plant|Amortissement cumulé des installations de fabrication et de traitement
1684|Buildings under construction|Bâtiments en construction
1740|Machinery, equipment, furniture and fixtures|Machines, matériel, meubles et accessoires
1741|Accumulated amortization of machinery, equipment, furniture and fixtures|Amortissement cumulé des machines, du matériel, des meubles et des accessoires
1742|Motor vehicles|Véhicules automobiles
1743|Accumulated amortization of motor vehicles|Amortissement cumulé des véhicules automobiles
1744|Tools and dies|Outils et matrices
1745|Accumulated amortization of tools and dies|Amortissement cumulé sur les outils et les matrices
1746|Construction and excavating equipment|Matériel de construction et d'excavation
1747|Accumulated amortization of construction and excavating equipment|Amortissement cumulé du matériel de construction et d'excavation
1748|Forestry and logging equipment|Matériel d'exploitation forestière
1749|Accumulated amortization of forestry and logging equipment|Amortissement cumulé du matériel d'exploitation forestière
1750|Fishing gear and nets|Filets et matériel de pêche
1751|Accumulated amortization of fishing gear and nets|Amortissement cumulé des filets et du matériel de pêche
1752|Mining equipment|Matériel d'exploitation minière
1753|Accumulated amortization of mining equipment|Amortissement cumulé du matériel d'exploitation minière
1754|Oil and gas systems|Réseaux pétroliers et gaziers
1755|Accumulated amortization of oil and gas systems|Amortissement cumulé des réseaux pétroliers et gaziers
1756|Production equipment for resource industries|Matériel de production pour les industries de ressources naturelles
1757|Accumulated amortization of production equipment for resource industries|Amortissement cumulé du matériel de production de ressources naturelles
1758|Production equipment for other industries|Matériel de production autre que pour les industries de ressources naturelles
1759|Accumulated amortization of production equipment for other industries|Amortissement cumulé du matériel de production autre que pour les industries des ressources naturelles
1760|Exploration equipment|Matériel d'exploration
1761|Accumulated amortization of exploration equipment|Amortissement cumulé du matériel d'exploration
1762|Shipping equipment|Matériel d'expédition
1763|Accumulated amortization of shipping equipment|Amortissement cumulé du matériel d'expédition
1764|Ships and boats|Navires et bateaux
1765|Accumulated amortization of ships and boats|Amortissement cumulé des navires et des bateaux
1766|Aircraft|Aéronefs
1767|Accumulated amortization of aircraft|Amortissement cumulé des aéronefs
1768|Signs|Panneaux indicateurs
1769|Accumulated amortization of signs|Amortissement cumulé des panneaux indicateurs
1770|Small tools|Petits outils
1771|Accumulated amortization of small tools|Amortissement cumulé des petits outils
1772|Radio and communication equipment|Matériel de radio et de communication
1773|Accumulated amortization of radio and communication equipment|Amortissement cumulé du matériel de radio et de communication
1774|Computer equipment/software|Matériel informatique/logiciels
1775|Accumulated amortization of computer equipment/software|Amortissement cumulé du matériel informatique / logiciels
1776|Musical instruments|Instruments de musique
1777|Accumulated amortization of musical instruments|Amortissement cumulé des instruments de musique
1778|Satellites|Satellites
1779|Accumulated amortization of satellites|Amortissement cumulé des satellites
1780|Earth stations|Stations terrestres
1781|Accumulated amortization of earth stations|Amortissement cumulé des stations terrestres
1782|Machinery and equipment under construction|Machines et matériel en cours de fabrication
1783|Transportation equipment|Matériel de transport
1784|Accumulated amortization of transportation equipment|Amortissement cumulé du matériel de transport
1785|Other machinery and equipment|Autres machines et matériel
1786|Accumulated amortization of other machinery and equipment|Amortissement cumulé des autres machines et d'autre matériel
1787|Furniture and fixtures|Meubles et accessoires
1788|Accumulated amortization of furniture and fixtures|Amortissement cumulé des meubles et des accessoires
1900|Other tangible capital assets|Autres immobilisations
1901|Accumulated amortization of other tangible capital assets|Amortissement cumulé des autres immobilisations
1902|Logging roads|Chemins d'exploitation forestière
1903|Accumulated amortization of logging roads|Amortissement cumulé des chemins d'exploitation forestière
1904|Asphalt and parking areas|Aires asphaltées et parcs de stationnement
1905|Accumulated amortization of asphalt and parking areas|Amortissement des aires asphaltées et des parcs de stationnement
1906|Wharves, docks and marinas|Quais
1907|Accumulated amortization of wharves, docks and marinas|Amortissement cumulé des quais
1908|Fences|Clôtures
1909|Accumulated amortization of fences|Amortissement cumulé des clôtures
1910|Capital leases – buildings|Contrats de location – acquisition (bâtiments)
1911|Accumulated amortization of capital leases – buildings|Amortissement cumulé des contrats de location - acquisition (bâtiments)
1912|Capital leases – equipment|Contrats de location – acquisition (matériel)
1913|Accumulated amortization of capital leases – equipment|Amortissement cumulé des contrats de location – acquisition (matériel)
1914|Capital leases – vehicles|Contrats de location – acquisition (véhicules)
1915|Accumulated amortization of capital leases – vehicles|Amortissement cumulé des contrats de location – acquisition (véhicules)
1916|Capital leases – other|Contrats de location – acquisition (autres)panneaux
1917|Accumulated amortization of capital leases – other|Amortissement cumulé des contrats de location – acquisition (autres)
1918|Leasehold improvements|Améliorations locatives
1919|Accumulated amortization of leasehold improvements|Amortissement cumulé des améliorations locatives
1920|Other capital assets under construction|Autres immobilisations en construction
1921|Campsites|Aires de campings
1922|Accumulated amortization of campsites|Amortissement cumulé des aires de campings
2008|Total tangible capital assets|Total des immobilisations
2009|Total accumulated amortization of tangible capital assets|Total de l'amortissement cumulé des immobilisations
2010|Intangible assets|Actif incorporel
2011|Accumulated amortization of intangible assets|Amortissement cumulé de l'actif incorporel
2012|Goodwill|Achalandage
2013|Accumulated amortization of goodwill|Amortissement cumulé de l'achalandage
2014|Quota|Contingents
2015|Accumulated amortization of quota|Amortissement cumulé des contingents
2016|Licences|Permis
2017|Accumulated amortization of licences|Amortissement cumulé des permis
2018|Incorporation costs|Frais de constitution en société
2019|Accumulated amortization of incorporation costs|Amortissement cumulé des frais de constitution en société
2020|Trademarks and patents|Marques de commerce et brevets
2021|Accumulated amortization of trademarks and patents|Amortissement cumulé des marques de commerce et des brevets
2022|Customer lists|Listes de clients
2023|Accumulated amortization of customer lists|Amortissement cumulé des listes de clients
2024|Rights|Droits
2025|Accumulated amortization of rights|Amortissement cumulé des droits
2026|Research and development|Recherche et développement
2027|Accumulated amortization of research and development|Amortissement cumulé de la recherche et du développement
2070|Resource rights|Droits relatifs à des ressources
2071|Accumulated amortization of resource rights|Amortissement cumulé des droits relatifs à des ressources
2072|Timber rights|Droits de coupe
2073|Accumulated amortization of timber rights|Amortissement cumulé des droits de coupe
2074|Mining rights|Droits miniers
2075|Accumulated amortization of mining rights|Amortissement cumulé des droits miniers
2076|Oil and gas rights|Droits pétroliers et gaziers
2077|Accumulated amortization of oil and gas rights|Amortissement cumulé des droits pétroliers et gaziers
2178|Total intangible capital assets|Total de l'actif incorporel
2179|Total accumulated amortization of intangible capital assets|Total de l'amortissement cumulé de l'actif incorporel
2180|Due from shareholder(s)/director(s)|Sommes exigibles d'actionnaire(s)/ d'administrateur(s)
2181|Due from individual shareholder(s)|Sommes exigibles d'actionnaire(s) (particuliers)
2182|Due from corporate shareholder(s)|Sommes exigibles d'actionnaire(s) (sociétés)
2183|Due from director(s)|Sommes exigibles d'administrateur(s)
2190|Due from members|Sommes exigibles des membres
2200|Investment in joint venture(s)/partnership(s)|Placements dans une(des) coentreprise(s)/société(s) de personnes
2220|Due from joint venture(s)/partnership(s)|Sommes exigibles de coentreprise(s)/société(s)de personnes
2240|Due from/investment in related parties|Sommes exigibles des personnes apparentées/
2241|Due from/investment in Canadian related parties|Sommes exigibles de/placements dans des personnes canadiennes apparentées
2242|Shares in Canadian related corporations|Actions dans des sociétés canadiennes apparentées
2243|Loans/Advances to Canadian related corporations|Prêts/avances à des sociétés canadiennes apparentées
2244|Investment in Canadian related corporations at cost|Placements dans des sociétés canadiennes apparentées à la valeur d'acquisition
2245|Investment in Canadian related corporations at equity|Placements dans des sociétés canadiennes apparentées à la valeur de consolidation
2246|Due from/investment in foreign related parties|Sommes exigibles de/placements dans des parties étrangères apparentées
2247|Shares in foreign related corporations|Actions dans des sociétés étrangères apparentées
2248|Loans/Advances to foreign related corporations|Prêts/avances à des sociétés étrangères apparentées
2249|Investment in foreign related corporations at cost|Placements dans des sociétés étrangères apparentées à la valeur d'acquisition
2250|Investment in foreign related corporations at equity|Placements dans des sociétés étrangères apparentées à la valeur de consolidation
2280|Investment in co-tenancy|Placements dans des locations en partenariat
2300|Long term investments|Placements à long terme
2301|Foreign shares|Actions dans des sociétés étrangères
2302|Other type of foreign investments|Autres genres de placements à l'étranger
2303|Canadian shares|Actions dans des sociétés canadiennes
2304|Government of Canada debt|Titres de créances du gouvernement du Canada
2305|Canadian provinvial and municipal government debt|Titres de créances des gouvernements provinciaux et des administrations municipales du Canada
2306|Canadian corporate bonds and debentures|Obligations et débentures de sociétés canadiennes
2307|Debt securities|Titres de créances
2308|Equity securities|Titres de participation
2309|Securities purchased under resale agreements|Titres acquis à la suite d'une entente de rachat
2310|Central credit union shares|Actions de la caisse de crédit centrale
2311|Other long term Canadian investments|Autres placements canadiens à long terme
2360|Long term loans|Prêts à long terme
2361|Mortgages|Prêts hypothécaires
2362|Personal and credit card loans|Prêts personnels et prêts sur carte de crédit
2363|Business and government loans|Prêts au gouvernement et prêts commerciaux
2364|Line of credit|Marge de crédit
2420|Other long term assets|Autres éléments d'actif à long terme
2421|Deferred income taxes / tax reserves|Impôts sur le revenu reportés
2422|Deferred pension charges|Frais du régime de pension reportés
2423|Deferred unrealized exchange losses|Pertes de change non matérialisées reportées
2424|Other deferred items/charges|Autres éléments/frais reportés
2425|Accumulated amortization of deferred charges|Amortissement cumulé des frais reportés
2426|Reserve fund|Fonds de réserve
2427|Cash surrender value of life insurance|Valeur de rachat de l'assurance-vie
2589|Total long term assets|Total de l'actif à long terme
2590|Assets held in trust|Actif détenu en fiducie
2599|Total assets|Total de l'actif
2600|Bank overdraft|Découvert bancaire
2620|Amounts payable and accrued liabilities|Montants et charges à payer
2621|Accounts payable trade|Effets commerciaux à payer
2622|Accounts payable to related parties|Effets commerciaux à payer à des personnes apparentées
2623|Holdbacks payable|Retenues de garantie à payer
2624|Wages payable|Salaires à payer
2625|Management fees payable|Frais de gestion à payer
2626|Bonuses payable|Gratifications à payer
2627|Employee deductions payable|Retenues salariales à payer
2628|Withholding taxes payable|Retenues d'impôts et de taxes à payer
2629|Interest payable|Intérêts à payer
2630||Montants à payer aux membres d'OSBL
2680|Taxes payable|Taxes et impôts à payer
2700|Short term debt|Dettes à court terme
2701|Loans from Canadian banks|Emprunts auprès de banques canadiennes
2702|Liability for securities sold short|Élément de passif pour les titres vendus à découvert
2703|Liability for securities sold under repurchase agreements|Élément de passif pour les titres vendus à la suite d'une entente de rachat
2704|Gold and silver certificates|Titres sur l'or et sur l'argent
2705|Cheques and other items in transit|Chèques et autres items en circulation
2706|Lien notes|Billets garantis
2770|Deferred income|Revenus reportés
2780|Due to shareholder(s)/director(s)|Sommes dues à un(des) actionnaire(s)/administrateur(s)
2781|Due to individual shareholder(s)|Sommes dues à un(des) actionnaire(s) (particuliers)
2782|Due to corporate shareholder(s)|Sommes dues à un(des) actionnaire(s) (sociétés)
2783|Due to director(s)|Sommes dues à un(des) administrateur(s)
2840|Due to joint venture(s)/partnership(s)|Sommes dues à une(des) coentreprise(s)/ société(s) de personnes
2860|Due to related parties|Sommes dues à des personnes apparentées
2861|Demand notes due to related parties|Billets à demande dus à des personnes apparentées
2862|Interest payable to related parties|Intérêts à payer à des personnes apparentées
2863|Advances due to related parties|Avances à payer à des personnes apparentées
2920|Current portion of long term liability|Portion à court terme du passif à long terme
2940||Acceptations de banque
2960|Other current liabilities|Autres éléments du passif à court terme
2961|Deposits received|Sommes reçues en dépôts
2962|Dividends payable|Dividendes à payer
2963|Deferred income taxes|Impôts sur le revenu reportés
2964|Reserves for guarantees, warranties or indemnities|Réserve pour garanties et indemnités
2965|General reserves / provisions|Provisions et réserves générales
2966|Crew shares|Parts des membres de l'équipage
3139|Total current liabilities|Total du passif à court terme
3140|Long term debt|Dette à long terme
3141|Mortgages|Hypothèques
3142|Farm Credit Corporation loan|Emprunts d'une société de crédit agricole
3143|Chartered bank loan|Emprunt d'une banque à charte
3144|Credit union/caisse populaire loan|Emprunt d'une caisse populaire/d'une coopérative de crédit
3145|Provincial government loan|Emprunt du gouvernement provincial
3146|Supply company loan|Emprunt d'un fournisseur
3147|Private loan|Prêt personnel
3148|Central, leagues and federation loans|Emprunts d'une fédération, d'une centrale ou de
3149|Line of credit|Marge de crédit
3150|Liability for securities sold short|Élément de passif pour les titres vendus à
3151|Liability for securities sold under repurchase agreements|Élément de passif pour les titres vendus à la suite d'une entente de rachat
3152|Lien notes|Billets garantis
3200||Cautionnement des institutions financières
3210|Bonds and debentures|Obligations et débentures
3220|Deferred income|Revenus reportés
3240|Deferred income taxes|Impôts sur le revenu reportés
3260|Long term due to shareholder(s)/director(s)|Sommes dues à un(des) actionnaire(s)/ administrateur(s)
3261|Long term due to individual shareholder(s)|Sommes dues à un(des) actionnaire(s) (particuliers)
3262|Long term due to corporate shareholder(s)|Sommes dues à un(des) actionnaire(s) (sociétés)
3263|Long term due to director(s)|Sommes dues à un(des) administrateur(s)
3270||Sommes dues à des membres
3280|Long term due to joint venture(s)/partnership(s)|Sommes dues à une(des) coentreprise(s)/société(s) de personnes
3300|Long term due to related parties|Sommes dues à des personnes apparentées
3301|Amounts owing to related Canadian parties|Sommes dues à des personnes canadiennes apparentées
3302|Amounts owing to related foreign parties|Sommes dues à des personnes étrangères apparentées
3320|Other long term liabilities|Autres éléments de passif à long terme
3321|Long term obligations/commitments/leases|Obligations, engagements et location-acquisition à long terme
3322|Reserves for guarantees, warranties or indemnities|Réserves pour garanties et indemnités
3323|Provision for site restoration|Provision pour la restauration des sites d'exploitation
3324|Contributions to qualifying environmental trust|Contribution à une fiducie pour l'environnement
3325|General provisions / reserves|Provisions et réserves générales
3326|Preference shares restated|Redressement pour les actions privilégiées
3327|Member allocations|Répartition aux membres
3328|Deferred income from incomplete contracts|Revenus différés de contrats incomplets
3450|Total long term liabilities|Total du passif à long terme
3460|Subordinated debt|Dettes de second rang
3470|Amounts held in trust|Sommes détenues en fiducie
3499|Total liabilities|Total du passif
3500|Common shares|Actions ordinaires
3520|Preferred shares|Actions privilégiées
3540|Contributed and other surplus|Surplus d'apport et autres surplus
3541|Contributed surplus|Surplus d'apport
3542|Appraisal surplus|Surplus d'expertise
3543|General reserve|Réserve générale
3570|Head office account|Compte du siège social
3600|Retained earnings/deficit|Bénéfices non répartis/déficit
3620|Total shareholder equity|Total des capitaux propres
3640|Total liabilities and shareholder equity|Total du passif et des capitaux propres
3660|Retained earnings/deficit start|
3680|Net income/loss|Revenu net/perte nette
3700|Dividend declared|Dividendes déclarés
3701|Cash dividend|Dividendes en espèces
3702|Patronage dividend|Ristournes
3720|Prior year adjustments|Redressements sur exercices antérieurs
3740|Other items affecting retained earnings|Autres éléments touchant les bénéfices non répartis
3741|Share redemptions|Rachat d'actions
3742|Special reserves|Réserves spéciales
3743|Currency adjustments|Redressements relatifs aux devises
3744|Unusual revenue items|Éléments inhabituels de revenus
3745|Interfund transfers (NPO)|Transferts interfonds
3849|Retained earnings/deficit end|Bénéfices non répartis/déficit – fin de l'exercice
8000|Trade sales of goods and services|Ventes commerciales de biens et services
8020|Sales to related parties|Ventes de biens et de services à des personnes apparentées
8030|Interdivisional sales|Ventes entre divisions
8040|Sales from resource properties|Ventes de ressources naturelles
8041|Petroleum and natural gas sales|Ventes de pétrole et de gaz naturel
8042|Petroleum and natural gas sales to related parties|Ventes de pétrole et de gaz naturel à des personnes apparentées
8043|Gas marketing|Commercialisation du gaz
8044|Processing revenue|Revenus de traitement
8045|Pipeline revenue|Revenus de transport par pipeline
8046|Seismic sales|Ventes reliées à l'exploration séismique
8047|Mining revenue|Revenus provenant de l'exploitation minière
8048|Coal revenue|Revenus provenant du charbon
8049|Oil sands revenue|Revenus de sables bitumineux
8050|Royalty income|Revenus provenant des redevances
8051|Oil and gas partnership/joint venture income/loss|Revenus/pertes d'une société de personnes/coentreprise – pétrole et gaz
8052|Mining partnership/joint venture income/loss|Revenus/pertes d'une société de personnes/coentreprise – mines
8053|Other production revenue|Autres revenus de production
8089|Total sales of goods and services|Total des ventes de biens et services
8090|Investment revenue|Revenus de placements
8091|Interest from foreign sources|Intérêt de sources étrangères
8092|Interest from Canadian bonds and debentures|Intérêt d'obligations et de débentures canadiennes
8093|Interest from Canadian mortgage loans|Intérêt de prêts hypothécaires canadiens
8094|Interest from other Canadian sources|Intérêt d'autres sources canadiennes
8095|Dividend income|Revenus de dividendes
8096|Dividend from Canadian sources|Dividendes de sources canadiennes
8097|Interest from foreign sources|Dividendes de sources étrangères
8100||Revenus d'intérêt (institutions financières)
8101||Intérêt de prêts
8102||Intérêt de valeurs mobilières
8103||Intérêt des dépôts en banque
8120|Commission revenue|Revenus de commissions
8121|Commission income on real estate transactions|Revenus de commissions sur les transactions immobilières
8140|Rental revenue|Revenus de location
8141|Real estate rental revenue|Revenus de location immobilière
8142||Revenus de location de films
8150|Vehicle leasing|Contrats de location de véhicules
8160|Fishing revenue|Revenus provenant de la pêche
8161|Fish products|Ventes de poisson
8162|Other marine products|Autres produits marins
8163|Fishing grants, credits and rebates|Subventions, crédits et dégrèvements de pêche
8164|Fishing subsidies|Subventions de pêche
8165|Compensation for loss of fishing income/property|Indemnité pour perte d'un revenu ou d'un bien de pêche
8166|Sharesman income|Revenu de pêcheur à la part
8210|Realized gains/losses on disposal of assets|Profits/pertes sur la disposition d'éléments d'actif
8211|Realized gains/losses on sale of investments|Profits/pertes sur la vente de placements
8212|Realized gains/losses on sale of resource properties|Profits/pertes sur la disposition d'avoir minier
8220|NPO amounts received|Montants reçus d'OSBL
8221|Membership fees|Frais d'adhésion
8222|Assessments|Cotisations
8223|Gifts|Dons
8224|Gross sales and revenues from organizational activities|Ventes et recettes brutes provenant d'activités de l'organisme
8230|Other revenue|Autres revenus
8231|Foreign exchange gains/losses|Gains/pertes sur devises étrangères
8232|Income/Loss of subsidiaries/affiliates|Revenus/pertes de filiales/de sociétés affiliées
8233|Income/Loss of other divisions|Revenus/pertes d'autres divisions
8234|Income/Loss of joint ventures|Revenus/pertes des coentreprises
8235|Income/Loss of partnerships|Revenus/pertes des sociétés de personnes
8236|Realization of deferred revenues|Réalisation de revenus différés
8237|Royalty income other than resource|Revenus de redevances autres que l'exploitation des ressources naturelles
8238|Alberta royalty tax credits|Crédits d'impôts pour redevances de l'Alberta
8239|Management and administration fees|Honoraires de gestion et d'administration
8240|Telecommunications revenues|Revenus de télécommunications
8241|Consulting fees|Honoraires de consultation
8242|Subsidies and grants|Subventions et octrois
8243|Sale of by-products|Ventes de sous-produits
8244|Deposit services|Frais d'administration provenant du service des dépôts
8245|Credit services|Frais d'administration provenant du service du crédit
8246|Card services|Frais d'administration provenant du service des cartes bancaires
8247|Patronage dividends|Ristournes
8248|Insurance recoveries|Recouvrement d'assurance
8249|Expense recoveries|Recouvrement de frais
8250|Bad debt recoveries|Recouvrement des mauvaises créances
8299|Total revenue|Total des revenus
8300|Opening inventory|Stock d'ouverture
8301|Opening inventory – finished goods|Stock d'ouverture – produits finis
8302|Opening inventory – raw materials|Stock d'ouverture – matières premières
8303|Opening inventory – goods in process|Stock d'ouverture – produits en cours de fabrication
8304|Opening inventory – work in process|
8320|Purchases / cost of materials|Achats/coût des matériaux
8340|Direct wages|Salaires directs
8350|Benefits on direct wages|Avantages sociaux relatifs aux salaires directs
8360|Trades and sub-contracts|Fournisseurs et sous-traitants
8370|Production costs other than resource|Coûts de production (autres que ressources naturelles)
8400|Resource production costs|Coûts de production des ressources naturelles
8401|Pipeline operations|Exploitation des pipelines
8402|Drilling|Forage
8403|Site restoration costs|Coûts de restauration des sites d'exploitation
8404|Gross overriding royalty|Redevances dérogatoires brutes
8405|Freehold royalties|Redevances de propriété franche
8406|Other producing properties rental|Paiements de location de concessions publiques
8407|Prospect and geological|Prospection/travaux de géologie
8408|Well operating, fuel and equipment|Exploitation des puits, carburant et matériel
8409|Well abandonment and dry holes|Abandon de puits et puits secs
8410|Other lease rentals|Autres paiements de location
8411|Exploration expenses, aerial surveys|Frais d'exploration
8412|Development expenses, stripping costs|Frais d'aménagement
8435|Crown charges|Sommes exigées par la Couronne
8436|Crown royalties|Redevances à la Couronne
8437|Crown lease rentals|Frais de location de la Couronne
8438|Freehold mineral tax|Impôts sur le minerai de propriété franche
8439|Mining taxes|Impôts miniers
8440|Oil and sand leases|Frais de location des sables bitumineux
8441|Saskatchewan resource surcharge|Surtaxe de la Saskatchewan sur les ressources
8450|Other direct costs|Autres coûts directs
8451|Equipment hire and operation|Location et exploitation de matériel
8452|Log yard|Cour à bois
8453|Forestry costs|Coûts d'exploitation forestière
8454|Logging road costs|Coûts des chemins forestiers
8455|Stumpage costs|Droits de coupe
8456|Royalty costs|Coûts des redevances
8457|Freight in and customs duty|Frais de transport à l'achat et droits
8458|Inventory write down|Moins-value de l'inventaire
8459|Direct cost amortization of tangible assets|Coût direct de l'amortissement des biens corporels
8460|Direct cost amortization of natural resource assets|Coût direct de l'amortissement des biens constitués
8461|Overhead expenses allocated to cost of sales|Autres frais indirects attribués au coût des ventes
8500|Closing inventory|Stock de fermeture
8501|Closing inventory – finished goods|Stock de fermeture – produits finis
8502|Closing inventory – raw materials|Stock de fermeture – matières premières
8503|Closing inventory – goods in process|Stock de fermeture – travaux en cours de fabrication
8504|Closing inventory – work in process|
8518|Cost of sales|Coût des ventes
8519|Gross profit/loss|Profit brut/perte brute
8520|Advertising and promotion|Publicité et promotion
8521|Advertising|Publicité
8522|Donations|Dons
8523|Meals and entertainment|Repas et frais de représentation
8524|Promotion|Promotion
8570|Amortization of intangible assets|Amortissement de biens incorporels
8590|Bad debt expense|Créances irrécouvrables
8610|Loan losses|Pertes sur prêts
8611|Provision for loan losses|Provision pour les pertes sur prêts
8620|Employee benefits|Avantages sociaux
8621|Group insurance benefits|Assurances collectives
8622|Employers portion of employee benefits|Partie de l'employeur des avantages sociaux
8623|Contributions to deferred income plans|Cotisations aux régimes de revenus différés
8650|Amortization of natural resource assets|Amortissement des biens constitués par des ressources naturelles
8670|Amortization of tangible assets|Amortissement des biens corporels
8690|Insurance|Assurances
8691|Life insurance on executives|Assurance sur la vie des dirigeants
8710|Interest and bank charges|Intérêts et frais bancaires
8711|Interest on short term debt|Intérêts sur les dettes à court terme
8712|Interest on bonds and debentures|Intérêts sur les obligations et les débentures
8713|Interest on mortgages|Intérêts sur les prêts hypothécaires
8714|Interest on long term debt|Intérêts sur les dettes à long terme
8715|Bank charges|Frais bancaires
8716|Credit card charges|Frais de cartes de crédit
8717|Collection and credit costs|Frais de recouvrement et de crédit
8740||Intérêts payés (institutions financières)
8741||Intérêts payés sur dépôts
8742||Intérêts payés sur les obligations et les débentures
8760|Business taxes, licences and memberships|Taxes d'affaires, droits d'adhésion et licences
8761|Memberships|Droits d'adhésion
8762|Business taxes|Taxes d'affaires
8763|Franchise fees|Frais de franchise
8764|Government fees|Frais à verser aux gouvernements
8780|New brunswick tax on large corporations|Taxe des grandes sociétés du Nouveau-Brunswick
8790|Nova scotia tax on large corporations|Taxe des grandes sociétés de la Nouvelle-Écosse
8810|Office expenses|Frais de bureau
8811|Office stationery and supplies|Papeterie et fournitures de bureau
8812|Office utilities|Services de bureau
8813|Data processing|Traitement des données
8860|Professional fees|Honoraires professionnels
8861|Legal fees|Frais légaux
8862|Accounting fees|Frais comptables
8863|Consulting fees|Honoraires d'experts-conseils
8864|Architect fees|Honoraires d'architectes
8865|Appraisal fees|Frais d'évaluation
8866|Laboratory fees|Frais de laboratoire
8867|Medical fees|Honoraires médicaux
8868|Veterinary fees|Frais de vétérinaire
8869|Brokerage fees|Frais de courtage
8870|Transfer fees|Frais de transfert
8871|Management and administration fees|Frais de gestion et d'administration
8872|Refining and assay|Affinage et dosage
8873|Registrar and transfer agent fees|Droits d'enregistrement et frais d'agents de transfert
8874|Restructuring costs|Coûts de restructuration
8875|Security and exchange commission fees|Commissions sur les titres et les valeurs mobilières
8876|Training expense|Frais de formation
8877|Studio and recording|Studio et enregistrement
8910|Rental|Frais de location
8911|Real estate rental|Loyer de biens immobiliers
8912|Occupancy costs|Frais d'occupation
8913|Condominium fees|Frais de copropriété
8914|Equipment rental|Location de matériel
8915|Motor vehicle rental|Location de véhicules motorisés
8916|Moorage (boat)|Amarrage (bateau)
8917|Storage|Entreposage
8918|Quota rental|Location de contingents
8960|Repairs and maintenance|Réparations et entretien
8961|Repairs and maintenance – buildings|Réparations et entretien – bâtiments
8962|Repairs and maintenance – vehicles|Réparations et entretien – véhicules
8963|Repairs and maintenance – boats|Réparations et entretien – bateaux
8964|Repairs and maintenance – machinery and equipment|Réparations et entretien – machines et matériel
9010|Other repairs and maintenance – janitor and yard|Autres frais de réparation et d'entretien
9011|Machine shop expense|Dépense d'usinage
9012|Road costs|Frais relatifs aux routes
9013|Security|Sécurité
9014|Garbage removal|Enlèvement des déchets
9060|Salaries and wages|Salaires et traitements
9061|Commissions|Commissions
9062|Crew share|Part de l'équipage
9063|Bonuses|Gratifications
9064|Director's fees|Jetons de présence des administrateurs
9065|Management salaries|Salaires des cadres
9066|Employee salaries|Salaires des employés
9110|Sub-Contracts|Contrats de sous-traitance
9130|Supplies|Fournitures
9131|Small tools|Petit outillage
9132|Shop expense|Frais d'atelier
9133|Uniforms|Uniformes
9134|Laundry|Blanchissage
9135|Food and catering|Alimentation et restauration
9136|Fishing gear|Matériel de pêche
9137|Nets and traps|Filets et pièges
9138|Salt, bait and ice|Sel, appâts et glace
9139|Camp supplies|Fournitures de camp
9150|Computer related expenses|Dépenses liées à l'informatique
9151|Upgrade|Améliorations et modernisations
9152|Internet|Internet
9180|Property taxes|Taxes foncières
9200|Travel expenses|Frais de déplacement
9201|Meetings and conventions|
9220|Utilities|Services publics
9221|Electricity|Électricité
9222|Water|Eau
9223|Heat|Chauffage
9224|Fuel costs|Frais de carburant
9225|Telephone and communications|Téléphone & Communications
9270|Other expenses|Autres dépenses
9271|Cash over/short|Écarts de caisse
9272|Reimbursement of parent company expense|Remboursement de frais de la société mère
9273|Selling expenses|Frais de vente
9274|Shipping and warehouse expenses|Frais de transport et d'entreposage
9275|Delivery, freight and express|Livraison, fret et messageries
9276|Warranty expenses|Frais de garantie
9277|Royalty expenses – resident|Frais de redevances – résidents
9278|Royalty expenses – non-resident|Frais de redevances – non-résidents
9279|Dumping charges|Frais de déchargement
9280|Land fill fees|Frais d'enfouissement
9281|Vehicle expenses|Frais de véhicules
9282|Research and development|Recherche et développement
9283|Withholding taxes|Retenues d'impôts
9284|General and administrative expenses|Frais d'administration et frais généraux
9285|Interdivisional expenses|Dépenses entre divisions
9286|Interfund transfer (NPO)|Transferts interfonds
9367|Total operating expenses|Total des frais d'exploitation
9368|Total expenses|Total des dépenses
9369|Net non-farming income|Revenu non agricole net
9370|Grains and oilseeds|Grains et oléagineux
9371|Wheat|Blé
9372|Oats|Avoine
9373|Barley|Orge
9374|Mixed grains|Grains mixtes
9375|Corn|Maïs
9376|Canola|Canola
9377|Flaxseed|Graine de lin
9378|Soya beans|Fèves soya
9379|Wheat board payments|Paiements de la Commission canadienne du blé
9420|Other crop revenues|Revenus d'autres récoltes
9421||Fruits
9422||Pommes de terre
9423||Légumes
9424||Tabac
9425||Produits de serre et de pépinière
9426||Récolte de fourrage
9470|Livestock and animal products revenue|Revenus du bétail et des produits d'origine
9471|Cattle|Bovins
9472|Swine|Porcins
9473|Poultry|Volaille
9474|Sheep and lambs|Ovins
9475|Pregnant mare urine (PMU)|Urine de jument gravide (UJG)
9476|Milk and cream – excluding dairy subsidies|Lait et crème (à l'exclusion des subventions pour
9477|Eggs for consumption|OEufs pour la consommation
9478|Hatching eggs|Couvaison des oeufs
9479|Aquaculture|Aquaculture (couvée et élevage)
9480|Horses – breeding and meat|Chevaux (reproduction et viande)
9520|Other commodities|Autres produits
9521|Maple products|Produits de l'érable
9522|Artificial insemination (AI)|Insémination artificielle
9523|Semen production|Production de sperme
9524|Embryo production|Production d'embryon
9540|Program payment revenues|Revenus des paiements de programmes
9541|Dairy subsidies|Subventions laitières
9542|Crop insurance|Assurance-récolte
9543|NISA payments|Paiements du CSRN
9544|Disaster assistance program payments|Paiements provenant du programme d'aide en cas de catastrophe
9570|Rebates|Remises
9571|Rebates – fuel|Remises – carburant
9572|Rebates – interest|Remises – intérêt
9573|Rebates – property taxes|Remises – taxes foncières
9574|Resales, rebates, GST for NISA eligible expenses|Reventes, Remises de la TPS pour les dépenses
9575|Rebates, GST for NISA non-eligible expenses|Remises de la TPS pour les dépenses non
9600|Other farm revenues/losses|Autres revenus/pertes agricoles
9601|Custom or contract work|Travail sur commande ou en sous-traitance
9602|Wood sales|Ventes de bois
9603|Horse racing|Courses de chevaux
9604|Insurance proceeds|Produits d'assurance
9605|Patronage dividends|Ristournes
9606|Rental income|Revenu de location
9607|Interest income|Revenu en intérêt
9608|Dividend income|Revenu de dividendes
9609|Gains/Losses on disposal of assets|Profits/pertes sur la disposition de biens
9610|Gravel|Gravier
9611|Trucking|Camionnage
9612|Resale of commodities purchased|Revente des denrées achetées
9613|Leases|Contrat-location (carburant, huile, puits, superficie, etc.)
9614|Machine rentals|Location de machines
9615|Farming partnership income/loss|Revenus/pertes des sociétés de personnes agricoles
9616|Farming joint venture income/loss|Revenus/pertes des coentreprises agricoles
9650|Non-Farming income|Revenu non agricole
9659|Total farm revenue|Total des revenus agricoles
9660|Crop expenses|Dépenses liées aux récoltes
9661|Containers, twine and baling wire|Contenants, ficelles et fils pour emballage
9662|Fertilizers and lime|Engrais et chaux
9663|Pesticides|Pesticides
9664|Seeds and plants|Semences et plantes
9665|Insurance premiums (crop) NISA ACS|Primes d'assurance (récolte) CSRN SAR
9710|Livestock expenses|Dépenses liées au bétail
9711|Feed, supplements, straw and bedding|Fourrage, suppléments, paille et litière
9712|Livestock purchases|Achats de bétail
9713|Veterinary fees, medicine and breeding fees|Frais de vétérinaire, de médicaments et de reproduction
9714||Sel et minéraux
9760|Machinery expenses|Dépenses liées aux machines
9761|Machinery insurance|Assurance pour les machines
9762|Machinery licences|Plaques pour les machines
9763|Machinery repairs|Réparation des machines
9764|Machinery fuel|Carburant pour les machines
9765|Machinery lease|Contrat-location de machines
9790|General farm expenses|Dépenses agricoles générales
9791|Amortization of tangible assets|Amortissement des biens corporels
9792|Advertising, marketing costs and promotion|Publicité, promotion et dépenses de mise en marché
9793|Bad debt|Mauvaises créances
9794|Benefits related to employee salaries|Avantages sociaux liés aux salaires des employés
9795|Building repairs and maintenance|Réparations et entretien des bâtiments
9796|Clearing, levelling and draining land|Défrichage, nivellement et drainage de terrains
9797|Crop insurance, GRIP and stabilization premiums|Primes d'assurance-récolte, de RARB et de
9798|Custom or contract work|Travail sur commande ou en sous-traitance
9799|Electricity|Électricité
9800|Fence repairs and maintenance|Réparations et entretien des clôtures
9801|Freight and trucking|Fret et camionnage
9802|Heating fuel and curing fuel|Combustible pour chauffage et pour salaison
9803|Insurance program overpayment recapture|Remboursement de paiements en trop provenant
9804|Other insurance premiums|Autres primes d'assurance
9805|Interest and bank charges|Intérêts et frais bancaires
9806|Marketing board fees|Droits versés à des offices de commercialisation
9807|Membership/Subscription fees|Frais d'adhésion
9808|Office expenses|Dépenses de bureau
9809|Professional fees|Honoraires professionnels
9810|Property taxes|Taxes foncières
9811|Rent – land and buildings|Location – terrain et bâtiments
9812|Rent – machinery|Location – machines
9813|Other rental expenses|Autres frais de location
9814|Salaries and wages|Salaires et traitements
9815|Salaries and wages other than spouse or dependants|Salaires (autre que conjoint et personnes à charge)
9816|Salaries and wages paid to dependants|Salaires versés aux personnes à charge
9817|Selling costs|Coûts des ventes
9818|Supplies|Fournitures
9819|Motor vehicle expenses|Dépenses concernant les véhicules motorisés
9820|Small tools|Petit outillage
9821|Soil testing|Analyses des sols
9822|Storage/Drying|Entreposage/séchage
9823|Licences/Permits|Licences/permis
9824|Telephone|Téléphone
9825|Quota rental|Location de contingents (tabac, laitier)
9826|Gravel|Gravier
9827|Purchases of commodities resold|Achats de produits pour la revente
9828|Salaries and wages paid to spouse|Salaires et traitements payés au conjoint
9829|Motor vehicle interest and leasing costs|Coûts de location et intérêt sur un véhicule
9830|Prepared feed|Aliments préparés
9831|Custom feed|Engraissement à forfait
9832|Amortization of intangible assets|Amortissement des biens incorporels
9833|Amortization of milk quota|Amortissement de quote-part de lait
9834|Travel expenses|Frais de déplacement
9835|Capital/Business taxes|Taxes d'affaires/sur le capital
9850|Non-Farming expenses|Dépenses non agricoles
9870|Net inventory adjustment|Régularisation des stocks
9898|Total farm expenses|
9899|Net farm income|Total des revenus agricoles nets
9970|Net income/loss before taxes and extraordinary items|Revenu net/perte nette avant impôts et éléments
9975|Extraordinary items|Élément(s) extraordinaire(s)
9976|Legal settlements|Règlements juridiques
9980|Unrealized gains/losses|Profits/pertes non matérialisés
9985|Unusual items|Éléments inhabituels
9990|Current income taxes|Impôts sur le revenu exigibles de l'exercice
9995|Deferred income tax provision|Provision pour impôts sur le revenu différés
9999|Net income/loss after taxes and extraordinary items|Revenu net/perte nette après impôts et éléments`;
  const LIST = DATA.split('\n').map(l => { const [code, en, fr] = l.split('|'); return { code, en: en || fr, fr: fr || en }; });
  const BY = new Map(LIST.map(x => [x.code, x]));

  // Which codes go with which kind of account.
  const RANGES = {
    Asset: [[1000, 2599]],
    Liability: [[2600, 3499]],
    Equity: [[3500, 3849]],
    Income: [[8000, 8299], [9370, 9659]],
    'Cost of Goods Sold': [[8300, 8519]],
    Expense: [[8520, 9369], [9660, 9999]],
  };
  const RANGE_TEXT = {
    Asset: '1000–2599', Liability: '2600–3499', Equity: '3500–3849', Income: '8000–8299',
    'Cost of Goods Sold': '8300–8519', Expense: '8520–9369',
  };

  /** Description of a code in 'en' or 'fr', or '' if it isn't in the list. */
  const describe = (code, lang) => { const x = BY.get(String(code || '')); return x ? (lang === 'fr' ? x.fr : x.en) : ''; };
  const fits = (code, type) => { const n = Number(code); return /^\d{4}$/.test(String(code)) && (RANGES[type] || []).some(([a, b]) => n >= a && n <= b); };
  /** Codes from the list that can go on an account of this type. */
  const forType = type => LIST.filter(x => fits(x.code, type));

  const TYPE_FR = { Asset: 'd’actif', Liability: 'de passif', Equity: 'de capitaux propres', Income: 'de revenus', 'Cost of Goods Sold': 'de coût des ventes', Expense: 'de charges' };
  /** Why a code can't go on an account, or '' if it can. */
  function problem(code, type, lang) {
    const c = String(code || '').trim();
    if (!c) return '';
    const r = (RANGE_TEXT[type] || '').replace('–', lang === 'fr' ? ' à ' : ' to ');
    if (!/^\d{4}$/.test(c)) return lang === 'fr' ? 'Un code IGRF compte 4 chiffres.' : 'A GIFI code is 4 digits.';
    if (!fits(c, type)) return lang === 'fr' ? `Le code IGRF ${c} ne convient pas à un compte ${TYPE_FR[type] || type}, qui utilise les codes ${r}.` : `GIFI code ${c} isn’t a code for ${type} accounts, which use ${r}.`;
    return '';
  }

  // A likely code for an account, from its kind and name (English or French). The bookkeeper checks it.
  const RULES = {
    Asset: [
      [/accum|amort/i, a => /vehic|truck|auto|camion|véhicule/i.test(a.name) ? '1743' : /comput|software|ordinat|logiciel|informat/i.test(a.name) ? '1775'
        : /furnit|mobilier|meuble/i.test(a.name) ? '1788' : /leasehold|locativ/i.test(a.name) ? '1919' : /building|bâtiment|immeuble/i.test(a.name) ? '1681'
        : /goodwill|achalandage|intangible|incorpor/i.test(a.name) ? '2011' : '1741'],
      [/petty cash|cash on hand|petite caisse|fonds de caisse/i, '1001'],
      [/allowance|doubtful|douteuse/i, '1061'],
      [/\b(gst|hst|qst|pst|tps|tvh|tvq|itc|cti|rti)\b|tax(es)? (receivable|recoverable)|à recevoir.*tax|tax.*à recevoir|impôts? à recevoir/i, '1066'],
      [/inventor|stock|marchandise/i, '1121'],
      [/prepaid|payé(e|es|s)? d.avance/i, '1484'],
      [/security deposit|dépôt de garantie/i, '1486'],
      [/shareholder|director|actionnaire|administrateur/i, '1301'],
      [/employee.*(advance|receivable)|avance.*employé/i, '1071'],
      [/investment|placement|term deposit|gic|cpg/i, '1180'],
      [/vehic|truck|auto|camion|véhicule/i, '1742'],
      [/comput|software|ordinat|logiciel|informat/i, '1774'],
      [/furnit|mobilier|meuble/i, '1787'],
      [/leasehold|améliorations locatives/i, '1918'],
      [/building|bâtiment|immeuble/i, '1680'],
      [/\bland\b|terrain/i, '1600'],
      [/goodwill|achalandage/i, '2012'],
      [/intangible|patent|trademark|incorporel|brevet|marque/i, '2010'],
      [/equipment|machinery|tools|matériel|équipement|machine|outil/i, '1740'],
      [/receivable|à recevoir/i, '1060'],
    ],
    Liability: [
      [/overdraft|découvert/i, '2600'],
      [/line of credit|marge de crédit/i, '2701'],
      [/shareholder|director|actionnaire|administrateur/i, '2781'],
      [/deferred|unearned|reporté|différé|perçu d.avance/i, '2770'],
      [/dividend/i, '2962'],
      [/current portion|tranche.*court terme|partie courante/i, '2920'],
      [/mortgage|hypoth/i, '3141'],
      [/wages payable|salaires? à payer/i, '2624'],
      [/deposits? received|dépôts? reçus?/i, '2961'],
      [/loan|emprunt|prêt|ceba|cuec/i, '3140'],
    ],
    Equity: [
      [/retained|non répartis|bénéfices/i, '3600'],
      [/common shares|share capital|capital-actions|actions ordinaires/i, '3500'],
      [/preferred shares|actions privilégiées/i, '3520'],
      [/contributed surplus|surplus d.apport/i, '3541'],
      [/dividend/i, '3700'],
    ],
    Income: [
      [/interest|intérêt/i, '8090'],
      [/dividend/i, '8095'],
      [/commission/i, '8120'],
      [/\brent|\bloyer|\blocation/i, '8140'],
      [/grant|subsid|subvention/i, '8242'],
      [/membership|adhésion|cotisation/i, '8221'],
      [/donation|gift|\bdons?\b/i, '8223'],
      [/(gain|loss).*(dispos|sale)|gain.*(cession|aliénation)/i, '8210'],
      [/foreign exchange|exchange gain|change/i, '8231'],
      [/recover|recouvr/i, '8249'],
      [/quick method|méthode rapide|sales tax|taxes conservées|other|autre|misc|divers/i, '8230'],
      [/.*/, '8000'],
    ],
    'Cost of Goods Sold': [
      [/subcontract|sous-trait/i, '8360'],
      [/direct (wage|labour|labor)|main-d.œuvre|salaires directs/i, '8340'],
      [/freight|transport|shipping/i, '8457'],
      [/purchase|material|achat|matériau/i, '8320'],
      [/.*/, '8518'],
    ],
    Expense: [
      [/interest.*bank|bank.*interest|intérêts? et frais bancaires/i, '8710'],
      [/credit card (fee|charge)|merchant|frais de carte/i, '8716'],
      [/bank|bancaire|service charge/i, '8715'],
      [/interest|intérêt/i, '8710'],
      [/advertis|marketing|promotion|publicité/i, '8520'],
      [/meal|entertain|repas|représentation/i, '8523'],
      [/bad debt|créances? (irrécouvrable|douteuse)/i, '8590'],
      [/amortiz|depreciat|amortissement/i, '8670'],
      [/insurance|assurance/i, '8690'],
      [/legal|lawyer|juridique|avocat/i, '8861'],
      [/accounting|bookkeep|audit|comptab|tenue de livres/i, '8862'],
      [/consult|conseil/i, '8863'],
      [/management fee|frais de gestion/i, '8871'],
      [/professional|honoraires/i, '8860'],
      [/office suppl|stationery|fournitures de bureau|papeterie/i, '8811'],
      [/office|bureau/i, '8810'],
      [/training|formation/i, '8876'],
      [/employer|\bcpp|\bei\b|\bqpp|qpip|\brrq|rqap|wsib|cnesst|benefit|avantages? sociaux|health services|\bfss\b|\beht\b|cotisations? de l.employeur|charges sociales/i, '8622'],
      [/equipment rental|location d.(équipement|matériel)/i, '8914'],
      [/\brent|\bloyer|\blease|\bbail\b/i, '8911'],
      [/repair|maintenance|réparation|entretien/i, '8960'],
      [/wage|salar|payroll|salaire|paie/i, '9060'],
      [/subcontract|sous-trait/i, '9110'],
      [/property tax|taxes foncières/i, '9180'],
      [/business tax|taxe d.affaires/i, '8762'],
      [/licen|permit|membership|dues|subscriptions? (to|for) (association|professional)|cotisation|permis|adhésion/i, '8760'],
      [/phone|telecom|communication|téléphone|cellulaire|mobile/i, '9225'],
      [/internet/i, '9152'],
      [/software|computer|subscription|saas|hosting|logiciel|informatique|abonnement/i, '9150'],
      [/fuel|gas\b|gasoline|carburant|essence/i, '9224'],
      [/vehic|auto\b|car expense|parking|véhicule|automobile|stationnement/i, '9281'],
      [/travel|voyage|déplacement|hébergement|lodging/i, '9200'],
      [/utilit|electric|hydro|heat|water|services publics|électricité|chauffage|eau\b/i, '9220'],
      [/deliver|freight|shipping|courier|postage|livraison|messagerie|poste|transport/i, '9275'],
      [/donation|gift|\bdons?\b|charit/i, '8522'],
      [/income tax|impôts? sur le (revenu|bénéfice)/i, '9990'],
      [/supplies|fournitures|matériel/i, '9130'],
      [/uncategori|suspense|ask my accountant|à classer|en suspens|quick method|méthode rapide|sales tax|non récupérées|other|autre|misc|divers/i, '9270'],
    ],
  };
  /** A likely GIFI code for an account, or '' when nothing fits well enough to suggest. */
  function suggest(a) {
    if (!a) return '';
    const d = a.detail || '';
    if (d === 'bank') return /petty|petite caisse|cash on hand|fonds de caisse/i.test(a.name || '') ? '1001' : '1002';
    if (d === 'ar') return '1060';
    if (d === 'ap' || d === 'card' || d === 'vacation_payable') return '2620';
    if (d === 'tax' || d === 'qst') return '2680';
    if (d === 'payroll_cra' || d === 'payroll_rq' || d === 'payroll_other') return '2627';
    if (d === 'ob') return '';
    if (d === 'wages') return '9060';
    if (d === 'payroll_tax') return '8622';
    for (const [re, code] of RULES[a.type] || []) {
      if (re.test(a.name || '')) return typeof code === 'function' ? code(a) : code;
    }
    return '';
  }

  return { LIST, describe, fits, forType, problem, suggest, RANGES, RANGE_TEXT };
});
