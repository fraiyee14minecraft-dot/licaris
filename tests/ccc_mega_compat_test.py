"""Regression cases for the compatibility generator, using original minimal fixtures."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('compat', Path(__file__).resolve().parents[1] / 'scripts/build-ccc-mega-compat.py')
compat = importlib.util.module_from_spec(spec)
spec.loader.exec_module(compat)


class CompatTests(unittest.TestCase):
    def test_shiny_aspects_are_order_independent(self):
        self.assertEqual(compat.aspect_key({'aspects': ['mega', 'shiny']}),
                         compat.aspect_key({'aspects': ['shiny', 'mega']}))

    def test_different_forms_without_aspects_are_not_collapsed(self):
        self.assertFalse(compat.overlaps_form({'name': 'Alpha'}, {'name': 'Beta'}))

    def test_same_form_with_different_spelling_case_overlaps(self):
        self.assertTrue(compat.overlaps_form({'name': 'Mega'}, {'name': 'MEGA'}))

    def test_exclusive_form_and_feature_survive_conflicting_dimensions(self):
        ccc = {'target': 'cobblemon:example', 'baseScale': 2, 'features': ['mega', 'custom'],
               'forms': [{'name': 'Mega', 'aspects': ['mega']}, {'name': 'Special', 'aspects': ['special']}]}
        owner = {'baseScale': 1, 'features': ['mega'], 'forms': [{'name': 'Mega', 'aspects': ['mega']}]}
        result = compat.trim_addition(ccc, [owner])
        self.assertNotIn('baseScale', result)
        self.assertEqual(result['features'], ['custom'])
        self.assertEqual(result['forms'], [{'name': 'Special', 'aspects': ['special']}])
        self.assertEqual(ccc['baseScale'], 2)

    def test_unique_evolution_preserved_but_same_id_not_duplicated(self):
        ccc = {'target': 'cobblemon:example', 'evolutions': [{'id': 'common'}, {'id': 'unique'}]}
        result = compat.trim_addition(ccc, [{'evolutions': [{'id': 'common', 'result': 'other'}]}])
        self.assertEqual(result['evolutions'], [{'id': 'unique'}])

    def test_target_only_addition_when_every_field_is_owned(self):
        self.assertEqual(compat.trim_addition({'target': 'cobblemon:example', 'baseScale': 2}, [{'baseScale': 1}]),
                         {'target': 'cobblemon:example'})


if __name__ == '__main__':
    unittest.main()
