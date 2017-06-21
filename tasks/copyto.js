'use strict';


module.exports = function copyto(grunt) {

    // Load task
    grunt.loadNpmTasks('grunt-copy-to');

	// Options
	return {
	    build: {
            files: [{
                expand: true,
                cwd: 'public',
                src: ['**/*'],
                dest: '.build/'
            }],
	        options: {
	            ignore: [
	            	'public/css/**/*',
	                'public/js/**/*',
	                'public/templates/**/*'
	            ]
	        }
	    },
        package: {
            files: [{
                expand: true,
                cwd: '.',
                src: ['**/*','.build/**'],
                dest: '.package/'
            }],
            options: {
                ignore: [
                    './start.sh'
                ]
            }
        },
        heroku: {
            files: [{
               expand: true,
                cwd: '.',
                src: ['**/*','.build/**','!node_modules/**'],
                dest: '.heroku/'
            }],
            options: {
                ignore: [
                    './start.sh'
                ]
            }
        }
    };
};
